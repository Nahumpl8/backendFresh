/**
 * Genera el PDF con la lista de productos y precios ("EXTRAS FRESH MARKET").
 *
 * Replica el que hoy se arma a mano en Canva cada semana (portada, índice de
 * secciones y una página por categoría con tarjetas de 4×3), pero sale de la
 * base de datos: los precios son los del momento en que se genera, y lo que
 * está agotado u oculto en la tienda no aparece.
 *
 * Cada tarjeta junta las presentaciones de un mismo producto ("500gr $52 /
 * 1 kg $98") agrupando por `nombreSinUnidades`, que tienen todos los productos.
 *
 * Fotos: en la base hay PNG y WebP de ~190 KB de media. pdfkit no admite WebP
 * y meterlas tal cual daría un PDF de ~40 MB, así que se convierten a JPEG de
 * tamaño de tarjeta con sharp (~15 KB) y se guardan en caché en disco.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');

const FUENTES = path.join(__dirname, '..', 'assets', 'fonts');
const LOGO = path.join(__dirname, '..', 'assets', 'freshmarket', 'logo.png');
const CACHE_IMG = path.join(os.tmpdir(), 'fresh-lista-img');

const C = {
    verde: '#2F5D0E',
    verdeClaro: '#5E9E2A',
    amarillo: '#F7D23B',
    amarilloTexto: '#FFE14D',
    naranja: '#C86A1E',
    textoVerde: '#2E5B0D',
    blanco: '#FFFFFF',
    gris: '#E8E8E8',
};

// Orden y nombre de las secciones. La clave es la categoría sin emoji.
const SECCIONES = [
    ['promociones', 'PROMOCIONES DE LA SEMANA'],
    ['carne de res', 'RES'],
    ['carne de cerdo', 'CERDO'],
    ['pescados y mariscos', 'PESCADOS Y MARISCOS'],
    ['pollo y aves', 'POLLO'],
    ['salchichoneria', 'SALCHICHONERÍA'],
    ['lacteos y huevo', 'LÁCTEOS Y HUEVO'],
    ['abarrotes y semillas', 'ABARROTES Y SEMILLAS'],
    ['verduras', 'VERDURAS'],
    ['frutas', 'FRUTAS'],
    ['otros', 'OTROS'],
];

const normalizar = (s) => String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

const dinero = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-MX');

// ---------------------------------------------------------------------------
// Agrupación
// ---------------------------------------------------------------------------

/**
 * Etiqueta de la presentación a partir del título del producto:
 * "500g de Maciza de cerdo $52" -> "500gr", "1Kg de Top Sirloin" -> "1 kg".
 * Devuelve null si el título no empieza por una cantidad reconocible.
 */
function presentacion(titulo) {
    const m = String(titulo).match(
        /^\s*(\d+(?:[.,]\d+)?)\s*(kg|kilos?|grs?|gramos|g|pzas?|pz|piezas?|ml|litros?|lts?|l|domos?|pencas?|manojos?|monojos?|paquetes?|paq|casilleros?)\b\.?/i);
    if (!m) return null;
    const n = m[1].replace(',', '.');
    const u = m[2].toLowerCase();
    if (/^(g|gr|grs|gramos)$/.test(u)) return `${n}gr`;
    if (/^(kg|kilo|kilos)$/.test(u)) return `${n} kg`;
    if (/^(pz|pza|pzas|pieza|piezas)$/.test(u)) return `${n} pza.`;
    if (/^(l|lt|lts|litro|litros)$/.test(u)) return `${n} L`;
    return `${n} ${u}`;
}

/** Clave de sección para una categoría ("Verduras 🥕" -> "verduras"). */
function seccionDe(categoria) {
    const n = normalizar(categoria);
    const s = SECCIONES.find(([k]) => n.startsWith(k));
    return s ? s[0] : 'otros';
}

/**
 * Agrupa productos en tarjetas por sección. Función pura (probada en
 * test/listaPdf.test.js).
 */
function agrupar(productos) {
    const tarjetas = new Map();
    for (const p of productos) {
        if (p.showInWeb === false || p.inStock === false || !(Number(p.price) > 0)) continue;
        const esPromoProd = /^promoci/i.test(normalizar((p.categories || [])[0]));
        // En las promociones la cantidad ES el producto ("2 kg de limón por $40"):
        // el nombre sin unidades la perdería. Se usa el título sin "PROMO de" ni precio.
        const nombre = (esPromoProd
            ? String(p.title || '').replace(/^\s*promo(ci[oó]n)?\s+de\s+/i, '')
            : String(p.nombreSinUnidades || p.title || ''))
            .replace(/\s*\$\s*\d+\s*$/, '').trim();
        if (!nombre) continue;
        const seccion = seccionDe((p.categories || [])[0]);
        // Sin artículos ni preposiciones: en la base conviven "Bisteces de res" y
        // "Bisteces Res" para el mismo producto en distinta presentación.
        const clave = seccion + '|' + normalizar(nombre).split(' ')
            .filter((w) => !['de', 'del', 'la', 'el', 'los', 'las', 'en'].includes(w)).join(' ');
        if (!tarjetas.has(clave)) {
            tarjetas.set(clave, {
                seccion,
                nombre: nombre.charAt(0).toUpperCase() + nombre.slice(1),
                img: null,
                presentaciones: [],
            });
        }
        const t = tarjetas.get(clave);
        // Solo URLs reales: en la base hay fotos guardadas como "blob:..." (vista
        // previa del navegador que el panel guardó por error), "test" o vacías.
        if (!t.img && /^https?:\/\//i.test(String(p.img || ''))) t.img = p.img;
        t.presentaciones.push({ etiqueta: presentacion(p.title), precio: Number(p.price) });
    }

    for (const t of tarjetas.values()) {
        t.presentaciones.sort((a, b) => a.precio - b.precio);
        // Sin cantidad reconocible en el título, sobra la etiqueta: el nombre ya
        // dice qué es ("Media pechuga aplanada", "PROMO de 2 kg de limón").
        if (t.presentaciones.length === 1 && !t.presentaciones[0].etiqueta) t.presentaciones[0].etiqueta = '';
        // Presentaciones repetidas (mismo tamaño): se queda la primera.
        const vistas = new Set();
        t.presentaciones = t.presentaciones.filter((p) => {
            const k = p.etiqueta || dinero(p.precio);
            if (vistas.has(k)) return false;
            vistas.add(k);
            return true;
        }).slice(0, 3);
    }

    const porSeccion = SECCIONES.map(([clave, titulo]) => ({
        clave, titulo,
        tarjetas: [...tarjetas.values()]
            .filter((t) => t.seccion === clave)
            .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
    })).filter((s) => s.tarjetas.length);

    return porSeccion;
}

/** Huella del catálogo: si no cambió nada, no hace falta regenerar el PDF. */
function huella(productos) {
    const filas = productos
        .filter((p) => p.showInWeb !== false && p.inStock !== false)
        .map((p) => [String(p._id), p.title, p.price, p.img, p.nombreSinUnidades, (p.categories || [])[0]].join('|'))
        .sort();
    return crypto.createHash('sha1').update(filas.join('\n')).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Imágenes
// ---------------------------------------------------------------------------

async function imagenTarjeta(url) {
    if (!url) return null;
    fs.mkdirSync(CACHE_IMG, { recursive: true });
    const archivo = path.join(CACHE_IMG, crypto.createHash('sha1').update(url).digest('hex') + '.jpg');
    if (fs.existsSync(archivo)) return archivo;
    try {
        const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000, maxContentLength: 8 * 1024 * 1024 });
        await sharp(Buffer.from(r.data))
            .rotate()
            .resize(360, 260, { fit: 'cover', position: 'centre' })
            .flatten({ background: '#ffffff' })     // PNG con transparencia -> fondo blanco
            .jpeg({ quality: 72, mozjpeg: true })
            .toFile(archivo);
        return archivo;
    } catch (e) {
        return null;   // foto rota: la tarjeta sale con un recuadro gris, el PDF no falla
    }
}

/** Descarga en paralelo con un tope, para no saturar ni el servidor ni imgbb. */
async function prepararImagenes(urls, concurrencia = 6) {
    const resultado = new Map();
    const pendientes = [...new Set(urls.filter(Boolean))];
    async function trabajador() {
        while (pendientes.length) {
            const u = pendientes.shift();
            resultado.set(u, await imagenTarjeta(u));
        }
    }
    await Promise.all(Array.from({ length: concurrencia }, trabajador));
    return resultado;
}

/** La zanahoria del logo, recortada y sin fondo blanco, para la portada. */
let _zanahoria = null;
async function zanahoria() {
    if (_zanahoria) return _zanahoria;
    try {
        const { data, info } = await sharp(LOGO)
            .extract({ left: 470, top: 225, width: 140, height: 325 })
            .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        for (let i = 0; i < data.length; i += 4) {
            if (data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235) data[i + 3] = 0;
        }
        _zanahoria = await sharp(data, { raw: info }).png().toBuffer();
    } catch (e) {
        _zanahoria = null;
    }
    return _zanahoria;
}

// ---------------------------------------------------------------------------
// Dibujo
// ---------------------------------------------------------------------------

const A4 = { w: 595.28, h: 841.89 };

function textoContorno(doc, texto, y, size, color) {
    doc.font('Bold').fontSize(size).lineWidth(1.1).strokeColor(color)
        .text(texto, 0, y, { width: A4.w, align: 'center', fill: false, stroke: true, characterSpacing: 2 });
}

function pie(doc, telegram) {
    doc.rect(0, A4.h - 62, A4.w, 62).fill(C.naranja);
    doc.fillColor(C.blanco).font('Bold').fontSize(13)
        .text('PIDE POR TELEGRAM O WHATSAPP', 0, A4.h - 52, { width: A4.w, align: 'center' });
    doc.font('SemiBold').fontSize(11)
        .text(`${telegram ? 't.me/' + telegram + '  ·  ' : ''}WhatsApp 771-234-66-20`, 0, A4.h - 32, { width: A4.w, align: 'center' });
}

async function portada(doc, { fecha, telegram }) {
    doc.rect(0, 0, A4.w, A4.h).fill(C.verde);
    doc.fillColor(C.amarilloTexto).font('Bold').fontSize(96)
        .text('EXTRAS', 0, 50, { width: A4.w, align: 'center' });
    textoContorno(doc, 'FRESH MARKET', 175, 46, C.amarilloTexto);

    const z = await zanahoria();
    if (z) doc.image(z, A4.w / 2 - 38, 270, { width: 76 });

    doc.fillColor(C.blanco).font('Bold').fontSize(17);
    doc.text('ELIGE Y COMPLEMENTA TU DESPENSA\nCON NUESTROS PRODUCTOS EXTRAS', 40, 470, { width: A4.w - 80, align: 'center', lineGap: 2 });
    doc.fontSize(20).text('o', 0, 538, { width: A4.w, align: 'center' });
    doc.fontSize(17).text('ARMA TU PEDIDO CON UNA\nCOMPRA MÍNIMA DE $320', 40, 572, { width: A4.w - 80, align: 'center', lineGap: 2 });

    doc.fillColor(C.amarilloTexto).font('SemiBold').fontSize(12)
        .text(`Precios al ${fecha}`, 0, 670, { width: A4.w, align: 'center' });
    doc.fillColor(C.blanco).font('Medium').fontSize(9.5)
        .text('Los precios cambian cada semana: pide siempre la lista actualizada.', 0, 690, { width: A4.w, align: 'center' });

    pie(doc, telegram);
}

function indice(doc, secciones, imagenes, telegram) {
    doc.rect(0, 0, A4.w, A4.h).fill(C.verde);
    textoContorno(doc, 'FRESH MARKET', 38, 44, C.amarilloTexto);
    doc.fillColor(C.blanco).font('Medium').fontSize(10.5)
        .text('Toca una sección para ir directo a ella', 0, 98, { width: A4.w, align: 'center' });
    doc.font('SemiBold').fontSize(20).text('SECCIONES', 36, 128);

    const cols = 4, gap = 12, x0 = 30, y0 = 165;
    const w = (A4.w - x0 * 2 - gap * (cols - 1)) / cols;
    const h = 150;
    secciones.forEach((s, i) => {
        const x = x0 + (i % cols) * (w + gap);
        const y = y0 + Math.floor(i / cols) * (h + gap);
        doc.roundedRect(x, y, w, h, 10).fill(C.blanco);
        const foto = imagenes.get((s.tarjetas.find((t) => imagenes.get(t.img)) || {}).img);
        if (foto) doc.image(foto, x + 8, y + 8, { fit: [w - 16, 92], align: 'center', valign: 'center' });
        doc.fillColor(C.textoVerde).font('Bold').fontSize(10.5)
            .text(s.titulo.charAt(0) + s.titulo.slice(1).toLowerCase(), x + 6, y + 108, { width: w - 12, align: 'center', underline: true });
        doc.goTo(x, y, w, h, 'sec-' + s.clave);   // la tarjeta lleva a su sección
    });
    pie(doc, telegram);
}

function encabezado(doc, titulo, numero) {
    doc.rect(0, 0, A4.w, A4.h).fill(C.amarillo);
    // Franja verde superior con borde inferior ondulado
    doc.save();
    doc.moveTo(0, 0).lineTo(A4.w, 0).lineTo(A4.w, 120)
        .bezierCurveTo(A4.w * 0.7, 150, A4.w * 0.35, 95, 0, 135).closePath().fill(C.verde);
    doc.restore();
    doc.fillColor(C.blanco).font('Bold').fontSize(titulo.length > 16 ? 26 : 38)
        .text(titulo, 32, 42, { width: A4.w - 190 });

    // Sello del logo arriba a la derecha
    doc.circle(A4.w - 78, 52, 70).fill(C.verdeClaro);
    doc.fillColor(C.blanco).font('Bold').fontSize(19).text('FRESH', A4.w - 140, 50, { width: 124, align: 'center', characterSpacing: 2 });
    doc.font('Medium').fontSize(11).text('Market', A4.w - 140, 73, { width: 124, align: 'center', characterSpacing: 1.5 });

    doc.rect(0, A4.h - 44, A4.w, 44).fill(C.verde);
    doc.fillColor(C.blanco).font('SemiBold').fontSize(10)
        .text(`Página ${numero}`, 0, A4.h - 28, { width: A4.w - 30, align: 'right' });
}

function tarjeta(doc, t, x, y, w, h, foto) {
    doc.roundedRect(x, y, w, h, 12).fill(C.blanco);
    const altoFoto = 92;
    if (foto) {
        doc.save();
        doc.roundedRect(x + 7, y + 7, w - 14, altoFoto, 8).clip();
        doc.image(foto, x + 7, y + 7, { cover: [w - 14, altoFoto], align: 'center', valign: 'center' });
        doc.restore();
    } else {
        doc.roundedRect(x + 7, y + 7, w - 14, altoFoto, 8).fill(C.gris);
    }

    // Nombres largos: se baja el tamaño hasta que quepa en 3 líneas.
    doc.fillColor(C.textoVerde).font('Bold');
    let tam = 10.5;
    for (; tam > 7.5; tam -= 0.5) {
        if (doc.fontSize(tam).heightOfString(t.nombre, { width: w - 12, lineGap: -1 }) <= 40) break;
    }
    doc.fontSize(tam).text(t.nombre, x + 6, y + altoFoto + 12, {
        width: w - 12, align: 'center', height: 42, ellipsis: true, lineGap: -1,
    });

    let py = y + altoFoto + 58;
    doc.font('SemiBold').fontSize(10.5).fillColor(C.textoVerde);
    for (const p of t.presentaciones) {
        doc.text(p.etiqueta ? `${p.etiqueta} ${dinero(p.precio)}` : dinero(p.precio), x + 4, py, { width: w - 8, align: 'center' });
        py += 14;
    }
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

/**
 * Genera el PDF. Devuelve { buffer, paginas, tarjetas, secciones, huella, generadoAt }.
 * @param productos  documentos de Product (con title, nombreSinUnidades, price, img, categories, inStock, showInWeb)
 */
async function generarListaPdf(productos, { telegram = process.env.TELEGRAM_BOT_USERNAME, ahora = new Date() } = {}) {
    const secciones = agrupar(productos);
    const todas = secciones.flatMap((s) => s.tarjetas);
    const imagenes = await prepararImagenes(todas.map((t) => t.img));

    const fecha = ahora.toLocaleDateString('es-MX', {
        timeZone: 'America/Mexico_City', day: 'numeric', month: 'long', year: 'numeric',
    });

    const doc = new PDFDocument({
        size: 'A4', margin: 0, autoFirstPage: false,
        info: { Title: `Extras Fresh Market — ${fecha}`, Author: 'Fresh Market' },
    });
    doc.registerFont('Bold', path.join(FUENTES, 'Poppins-Bold.ttf'));
    doc.registerFont('SemiBold', path.join(FUENTES, 'Poppins-SemiBold.ttf'));
    doc.registerFont('Medium', path.join(FUENTES, 'Poppins-Medium.ttf'));

    const trozos = [];
    doc.on('data', (b) => trozos.push(b));
    const fin = new Promise((ok) => doc.on('end', ok));

    let paginas = 0;
    const nuevaPagina = () => { doc.addPage(); paginas++; };

    nuevaPagina();
    await portada(doc, { fecha, telegram });
    nuevaPagina();
    indice(doc, secciones, imagenes, telegram);

    const cols = 4, filas = 3, gap = 12, x0 = 28, y0 = 160;
    const w = (A4.w - x0 * 2 - gap * (cols - 1)) / cols;
    const h = 196;
    for (const s of secciones) {
        for (let i = 0; i < s.tarjetas.length; i += cols * filas) {
            nuevaPagina();
            encabezado(doc, s.titulo, paginas);
            if (i === 0) doc.addNamedDestination('sec-' + s.clave, 'XYZ', 0, A4.h, null);
            s.tarjetas.slice(i, i + cols * filas).forEach((t, j) => {
                const x = x0 + (j % cols) * (w + gap);
                const y = y0 + Math.floor(j / cols) * (h + gap);
                tarjeta(doc, t, x, y, w, h, imagenes.get(t.img));
            });
        }
    }

    doc.end();
    await fin;
    return {
        buffer: Buffer.concat(trozos),
        paginas,
        tarjetas: todas.length,
        secciones: secciones.map((s) => ({ titulo: s.titulo, tarjetas: s.tarjetas.length })),
        sinFoto: todas.filter((t) => !imagenes.get(t.img)).length,
        huella: huella(productos),
        generadoAt: ahora,
    };
}

/** Lee los productos de la base y genera el PDF. */
async function generarDesdeBase(opciones) {
    const Product = require('../models/Product');
    const productos = await Product.find({}, 'title nombreSinUnidades price img categories inStock showInWeb').lean();
    return generarListaPdf(productos, opciones);
}

/** Huella actual del catálogo, sin generar nada (para saber si sirve la caché). */
async function huellaActual() {
    const Product = require('../models/Product');
    const productos = await Product.find({}, 'title nombreSinUnidades price img categories inStock showInWeb').lean();
    return huella(productos);
}

module.exports = { generarListaPdf, generarDesdeBase, huellaActual, agrupar, presentacion, seccionDe, huella };
