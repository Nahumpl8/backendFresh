/**
 * Encuestas de satisfacción.
 *
 * - Un día después de la entrega se manda por correo un enlace único
 *   (freshmarket.mx/encuesta/<token>) a quien tenga correo en su ficha.
 * - Máximo una encuesta por cliente cada 30 días: si no, se vuelve rutina.
 * - Al contestar gana un regalo (Config `encuestaRegalo`) que se agrega solo al
 *   primer pedido que haga en los 7 días siguientes, por cualquier canal
 *   (todos entran por POST /api/pedidos/new).
 * - Cada respuesta llega al grupo del equipo en Telegram; las malas se marcan
 *   para darles seguimiento desde el panel.
 *
 * Las preguntas viven en PREGUNTAS. Para cambiarlas: editar la lista y subir
 * VERSION. Las encuestas ya enviadas se responden con las preguntas actuales.
 */
const crypto = require('crypto');
const Encuesta = require('../models/Encuesta');
const Pedido = require('../models/Pedidos');
const Clientes = require('../models/Clientes');
const Despensas = require('../models/Despensas');
const Product = require('../models/Product');
const Ruta = require('../models/Ruta');
const Config = require('../models/Config');
const tg = require('./telegram');
const { sendEncuestaEmail } = require('./emailService');

const VERSION = 1;
const DIAS_ENTRE_ENCUESTAS = 30;
const DIAS_REGALO = 7;
const REGALO_DEFAULT = '1 penca de plátano';
const URL_ENCUESTA = 'https://www.freshmarket.mx/encuesta/';
const HORA_ENVIO = 10;   // hora de México a partir de la cual sale el envío del día

// Zonas a las que no se manda (pueblos y Real del Monte).
const EXCLUIDAS = /tizayuca|acayuca|zapotlan|tolcayuca|real del monte|mineral del monte/;

const CATEGORIAS = [
    { clave: 'carnes_rojas', nombre: 'Carnes rojas', emoji: '🥩', de: ['carne de res', 'carne de cerdo'] },
    { clave: 'pollo', nombre: 'Pollo', emoji: '🍗', de: ['pollo y aves'] },
    { clave: 'pescado', nombre: 'Pescados y mariscos', emoji: '🐟', de: ['pescados y mariscos'] },
    { clave: 'verduras', nombre: 'Verduras', emoji: '🥬', de: ['verduras'] },
    { clave: 'frutas', nombre: 'Frutas', emoji: '🍎', de: ['frutas'] },
    { clave: 'abarrotes', nombre: 'Lácteos, abarrotes y salchichonería', emoji: '🥚', de: ['lacteos y huevo', 'abarrotes y semillas', 'salchichoneria'] },
];
const NOMBRE_CATEGORIA = Object.fromEntries(CATEGORIAS.map((c) => [c.clave, `${c.emoji} ${c.nombre}`]));

/**
 * Tipos: estrellas (1-5), sino (+ detalle si "no"), categorias (1-5 por lo que
 * llevó), productos (cuáles no le gustaron + motivo), opciones (una + comentario),
 * multi (varias + otro), escala10 (0-10), texto.
 */
const PREGUNTAS = [
    { id: 'general', tipo: 'estrellas', texto: '¿Cómo calificarías tu pedido en general?', requerida: true },
    { id: 'completo', tipo: 'sino', texto: '¿Llegó todo completo?', detalle: '¿Qué faltó?', requerida: true },
    { id: 'calidad', tipo: 'categorias', texto: 'Califica la calidad de lo que llevaste' },
    { id: 'noGusto', tipo: 'productos', texto: '¿Hubo algún producto que no te gustó?', detalle: '¿Qué tuvo? (ej. muy maduro, golpeado, duro)' },
    {
        id: 'repartidor', tipo: 'opciones', texto: '¿Cómo te atendió el repartidor?',
        opciones: [{ v: 'muy_bien', t: 'Muy bien' }, { v: 'bien', t: 'Bien' }, { v: 'mal', t: 'Mal' }],
        detalle: 'Cuéntanos (opcional)',
    },
    { id: 'recomendacion', tipo: 'escala10', texto: '¿Qué tan probable es que nos recomiendes con un amigo o familiar?', requerida: true },
    {
        id: 'volver', tipo: 'multi', texto: '¿Qué te haría pedirnos cada semana?',
        opciones: [
            { v: 'ya', t: 'Ya pido cada semana 💚' },
            { v: 'precio', t: 'Mejores precios' },
            { v: 'variedad', t: 'Más variedad de productos' },
            { v: 'horario', t: 'Otro horario o día de entrega' },
            { v: 'promos', t: 'Más promociones' },
        ],
        detalle: 'Otro',
    },
    { id: 'deseado', tipo: 'texto', texto: '¿Qué producto te gustaría que tuviéramos?' },
    { id: 'comentario', tipo: 'texto', texto: '¿Algo más que quieras decirnos?' },
];

// ---------------------------------------------------------------------------
// Fechas (hora de México)
// ---------------------------------------------------------------------------
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const hoyMX = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const horaMX = () => Number(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City', hour: 'numeric', hour12: false })) % 24;
const sumarDias = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** "sábado, 31 Octubre 2026" -> "2026-10-31" */
function fechaAISO(fecha) {
    const m = String(fecha || '').toLowerCase().match(/(\d{1,2})\s+([a-záéíóú]+)\s+(\d{4})/);
    const mes = m ? MESES.indexOf(m[2]) : -1;
    return mes < 0 ? null : `${m[3]}-${String(mes + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
/** Regex para encontrar los pedidos de un día en Pedido.fecha */
function regexDeISO(iso) {
    const [a, m, d] = iso.split('-').map(Number);
    return new RegExp(`,\\s*${d}\\s+${MESES[m - 1]}\\s+${a}\\s*$`, 'i');
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const tel10 = (t) => { const d = String(t || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
const sinAcentos = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const limpiarCategoria = (c) => sinAcentos(c).replace(/[^a-z ]/g, '').trim();
const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
const primerNombre = (n) => {
    const p = String(n || '').split('-')[0].trim().split(/\s+/)[0] || '';
    return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : '';
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Respaldo por nombre, para productos sin categoría (agregados a mano o promos).
const POR_NOMBRE = [
    ['pescado', /tilapia|pescado|camaron|salmon|mojarra|basa|atun|marisco|surimi/],
    ['pollo', /pollo|pechuga|pierna|muslo|alita|milanesa de pollo|pavo entero|nugget/],
    ['carnes_rojas', /\bres\b|bistec|arrachera|ribeye|rib eye|chambarete|molida|cerdo|chuleta|costilla|maciza|lomo|chorizo|fajita|sirloin|t-bone|aguja|pastor|cecina/],
    ['abarrotes', /queso|jamon|salchicha|huevo|leche|crema|yogur|mantequilla|frijol|arroz|lenteja|aceite|tortilla|pan\b|salami|tocino|nuez|almendra|cacahuate|mole|semilla|avena|azucar|cafe/],
    ['frutas', /manzana|platano|limon|naranja|mandarina|guayaba|papaya|pina|sandia|melon|uva|mango|pera|fresa|toronja|tejocate|cana|kiwi|durazno|ciruela|granada|arandano|zarzamora|frambuesa|coco/],
    ['verduras', /jitomate|tomate|cebolla|zanahoria|papa\b|chayote|calabaza|calabacita|chile|cilantro|lechuga|pepino|brocoli|ejote|elote|nopal|ajo|aguacate|apio|perejil|espinaca|coliflor|betabel|rabano|camote|jicama|champinon|chicharo|pimiento|morron|acelga|hongo|poro|haba/],
];

function categoriaDe(categories, nombre) {
    const cs = (categories || []).map(limpiarCategoria);
    const c = CATEGORIAS.find((x) => x.de.some((d) => cs.includes(d)));
    if (c) return c.clave;
    const n = sinAcentos(nombre);
    const r = POR_NOMBRE.find(([, re]) => re.test(n));
    return r ? r[0] : null;
}
/** "PROMO de 2kg de limon $35" -> "2kg de limon" */
const nombreLimpio = (n) => String(n || '').replace(/\s*\$\s*\d[\d,.]*\s*$/, '').replace(/^promo\s+(de\s+)?/i, '').trim();

async function leerConfig(key, def) {
    const c = await Config.findOne({ key }).lean();
    return c && String(c.value).trim() ? String(c.value).trim() : def;
}
const regaloActual = () => leerConfig('encuestaRegalo', REGALO_DEFAULT);
async function envioAutomatico() { return (await leerConfig('encuestaAuto', 'si')) === 'si'; }

/** Lista de productos de los pedidos de una entrega, con su categoría. */
async function productosDe(pedidos, cacheDespensas) {
    const lista = new Map();
    const poner = (nombre, categories) => {
        const n = nombreLimpio(nombre);
        if (n && !lista.has(n.toLowerCase())) lista.set(n.toLowerCase(), { nombre: n.charAt(0).toUpperCase() + n.slice(1), categoria: categoriaDe(categories, n) });
    };
    for (const p of pedidos) {
        const nombreDespensa = String(p.despensa || '').trim();
        if (nombreDespensa && !/^(pedido|reposicion)$/i.test(nombreDespensa)) {
            if (!cacheDespensas.has(nombreDespensa)) {
                const d = await Despensas.findOne({ name: nombreDespensa }).populate('products.productId', 'title nombreSinUnidades categories').lean();
                cacheDespensas.set(nombreDespensa, d ? d.products.map((x) => x.productId).filter(Boolean) : []);
            }
            const quitados = new Set((p.deletedProducts || []).flatMap((x) => [String(x.id || ''), sinAcentos(x.nombre)]));
            for (const prod of cacheDespensas.get(nombreDespensa)) {
                if (quitados.has(String(prod._id)) || quitados.has(sinAcentos(prod.title))) continue;
                poner(prod.nombreSinUnidades || prod.title, prod.categories);
            }
        }
        for (const prod of p.newProducts || []) poner(prod.nombreSinUnidades || prod.title, prod.categories);
    }
    return [...lista.values()].slice(0, 60);
}

// ---------------------------------------------------------------------------
// Armar y mandar
// ---------------------------------------------------------------------------
let enCurso = null;   // { desde, hasta, total, enviadas, errores, at } del envío en marcha

/**
 * Quiénes recibirían encuesta por las entregas de los días [desde, hasta].
 * Devuelve { candidatos: [...], conteo }. No escribe nada.
 */
async function candidatos(desde, hasta) {
    const conteo = { clientes: 0, sinCorreo: 0, excluidos: 0, recientes: 0, elegibles: 0 };
    const elegidos = [];
    const vistos = new Set();
    const hace30 = new Date(Date.now() - DIAS_ENTRE_ENCUESTAS * 864e5);

    for (let iso = desde; iso <= hasta; iso = sumarDias(iso, 1)) {
        const pedidos = await Pedido.find({ fecha: regexDeISO(iso) }).lean();
        const porTel = new Map();
        for (const p of pedidos) {
            const t = tel10(p.telefono);
            if (!t || /^reposicion$/i.test(String(p.despensa || '').trim())) continue;
            if (!porTel.has(t)) porTel.set(t, []);
            porTel.get(t).push(p);
        }
        if (!porTel.size) continue;

        const rutas = await Ruta.find({ fechaReparto: iso }, { repartidorNombre: 1, 'pedidos.cel': 1 }).lean();
        const repartidorDe = new Map();
        for (const r of rutas) for (const rp of r.pedidos || []) if (tel10(rp.cel)) repartidorDe.set(tel10(rp.cel), r.repartidorNombre);

        for (const [t, peds] of porTel) {
            if (vistos.has(t)) continue;   // con entregas en dos días del rango: una sola encuesta
            vistos.add(t);
            conteo.clientes++;
            const cliente = await Clientes.findOne({ telefono: { $regex: `${t}$` } }, { nombre: 1, email: 1, direccion: 1 }).lean();
            const texto = sinAcentos([cliente && cliente.nombre, cliente && cliente.direccion, ...peds.map((p) => `${p.direccion} ${p.cliente}`)].join(' '));
            if (EXCLUIDAS.test(texto)) { conteo.excluidos++; continue; }
            if (!cliente || !emailValido(cliente.email)) { conteo.sinCorreo++; continue; }
            if (await Encuesta.exists({ telefono: t, createdAt: { $gte: hace30 } })) { conteo.recientes++; continue; }
            conteo.elegibles++;
            elegidos.push({ telefono: t, cliente, pedidos: peds, iso, repartidor: repartidorDe.get(t) || null });
        }
    }
    return { candidatos: elegidos, conteo };
}

async function crearYEnviar(c, origen, regalo, cacheDespensas) {
    const productos = await productosDe(c.pedidos, cacheDespensas);
    const encuesta = await Encuesta.create({
        token: crypto.randomBytes(16).toString('base64url'),
        telefono: c.telefono,
        nombre: c.cliente.nombre,
        email: String(c.cliente.email).trim().toLowerCase(),
        fechaEntrega: c.pedidos[0].fecha,
        entregaISO: c.iso,
        pedidos: c.pedidos.map((p) => p._id),
        repartidor: c.repartidor,
        categorias: [...new Set(productos.map((p) => p.categoria).filter(Boolean))],
        productos,
        version: VERSION,
        origen,
    });
    const ok = await sendEncuestaEmail({
        email: encuesta.email,
        nombre: primerNombre(encuesta.nombre),
        url: URL_ENCUESTA + encuesta.token,
        regalo,
    });
    await Encuesta.updateOne({ _id: encuesta._id }, { $set: { envio: { at: new Date(), ok, error: ok ? '' : 'No se pudo mandar el correo' } } });
    return ok;
}

/** Manda las encuestas de las entregas de [desde, hasta]. Corre en segundo plano. */
async function enviarRango(desde, hasta, origen = 'auto') {
    if (enCurso && !enCurso.terminado) throw new Error('Ya hay un envío en marcha');
    const { candidatos: lista, conteo } = await candidatos(desde, hasta);
    enCurso = { desde, hasta, origen, total: lista.length, enviadas: 0, errores: 0, conteo, at: new Date(), terminado: false };
    const regalo = await regaloActual();
    const cache = new Map();
    for (const c of lista) {
        try {
            const ok = await crearYEnviar(c, origen, regalo, cache);
            if (ok) enCurso.enviadas++; else enCurso.errores++;
        } catch (e) {
            // E11000: ya había encuesta de esa entrega (dos envíos cruzados). No es error del cliente.
            if (e.code !== 11000) { enCurso.errores++; console.error('❌ Encuesta:', e.message); }
        }
        await esperar(1500);   // el SMTP de GoDaddy limita la velocidad
    }
    enCurso.terminado = true;
    console.log(`📋 Encuestas ${desde}..${hasta} (${origen}): ${enCurso.enviadas} enviadas, ${enCurso.errores} errores`, conteo);
    return enCurso;
}
const estadoEnvio = () => enCurso;

/** Cada día, a partir de las 10:00, manda las de las entregas de ayer. */
function programarEnvioDiario() {
    const revisar = async () => {
        try {
            if (horaMX() < HORA_ENVIO || !(await envioAutomatico())) return;
            const hoy = hoyMX();
            // Se marca ANTES de enviar: con dos instancias o un reinicio no sale doble
            // (si ya dice hoy, el upsert choca con la clave única y se sale).
            try {
                await Config.updateOne({ key: 'encuestaUltimoEnvio', value: { $ne: hoy } }, { $set: { value: hoy, updatedAt: new Date() } }, { upsert: true });
            } catch (e) {
                if (e.code === 11000) return;
                throw e;
            }
            const ayer = sumarDias(hoy, -1);
            await enviarRango(ayer, ayer, 'auto');
        } catch (e) {
            console.error('❌ Envío diario de encuestas:', e.message);
        }
    };
    setTimeout(revisar, 60 * 1000);
    setInterval(revisar, 20 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Contestar (página pública)
// ---------------------------------------------------------------------------
function preguntasPara(encuesta) {
    return PREGUNTAS.map((p) => {
        if (p.tipo === 'categorias') {
            const cats = CATEGORIAS.filter((c) => (encuesta.categorias || []).includes(c.clave)).map((c) => ({ v: c.clave, t: `${c.emoji} ${c.nombre}` }));
            return cats.length ? { ...p, opciones: cats } : null;
        }
        if (p.tipo === 'productos') {
            const prods = (encuesta.productos || []).map((x) => x.nombre);
            return prods.length ? { ...p, opciones: prods.map((n) => ({ v: n, t: n })) } : null;
        }
        return p;
    }).filter(Boolean);
}

async function paraContestar(token) {
    const e = await Encuesta.findOne({ token: String(token || '') }).lean();
    if (!e) return null;
    return {
        nombre: primerNombre(e.nombre),
        fechaEntrega: e.fechaEntrega,
        regalo: e.regalo && e.regalo.texto ? e.regalo.texto : await regaloActual(),
        diasRegalo: DIAS_REGALO,
        respondida: Boolean(e.respondidaAt),
        regaloVence: e.regalo && e.regalo.venceAt,
        pideEmail: !emailValido(e.email),
        preguntas: e.respondidaAt ? [] : preguntasPara(e),
    };
}

const recorta = (s, n = 500) => String(s == null ? '' : s).trim().slice(0, n);

/** Valida y limpia lo que mandó la página. Lanza Error con mensaje para el cliente. */
function limpiarRespuestas(encuesta, body) {
    const r = {};
    for (const p of preguntasPara(encuesta)) {
        const v = body ? body[p.id] : undefined;
        const vacio = v == null || v === '' || (Array.isArray(v) && !v.length);
        if (vacio) {
            if (p.requerida) throw new Error(`Falta contestar: ${p.texto}`);
            continue;
        }
        const valores = (p.opciones || []).map((o) => o.v);
        switch (p.tipo) {
            case 'estrellas': {
                const n = Number(v); if (!(n >= 1 && n <= 5)) throw new Error(`Respuesta inválida: ${p.texto}`);
                r[p.id] = Math.round(n); break;
            }
            case 'escala10': {
                const n = Number(v); if (!(n >= 0 && n <= 10)) throw new Error(`Respuesta inválida: ${p.texto}`);
                r[p.id] = Math.round(n); break;
            }
            case 'sino': {
                const valor = v && v.valor;
                if (!['si', 'no'].includes(valor)) throw new Error(`Respuesta inválida: ${p.texto}`);
                r[p.id] = { valor, detalle: valor === 'no' ? recorta(v.detalle, 300) : '' }; break;
            }
            case 'categorias': {
                const out = {};
                for (const k of valores) { const n = Number(v && v[k]); if (n >= 1 && n <= 5) out[k] = Math.round(n); }
                if (Object.keys(out).length) r[p.id] = out; break;
            }
            case 'productos': {
                const out = (Array.isArray(v) ? v : []).filter((x) => x && valores.includes(x.nombre))
                    .slice(0, 20).map((x) => ({ nombre: x.nombre, motivo: recorta(x.motivo, 200) }));
                if (out.length) r[p.id] = out; break;
            }
            case 'opciones': {
                const valor = v && v.valor;
                if (!valores.includes(valor)) throw new Error(`Respuesta inválida: ${p.texto}`);
                r[p.id] = { valor, detalle: recorta(v.detalle, 300) }; break;
            }
            case 'multi': {
                const sel = (Array.isArray(v && v.valores) ? v.valores : []).filter((x) => valores.includes(x));
                const otro = recorta(v && v.otro, 200);
                if (sel.length || otro) r[p.id] = { valores: [...new Set(sel)], otro }; break;
            }
            case 'texto': { const t = recorta(v); if (t) r[p.id] = t; break; }
            default: break;
        }
    }
    return r;
}

/** Por qué una respuesta necesita seguimiento. */
function motivosDeMala(r) {
    const m = [];
    if (r.general != null && r.general <= 3) m.push(`Calificó ${r.general}/5`);
    if (r.completo && r.completo.valor === 'no') m.push('Faltó algo');
    for (const [k, n] of Object.entries(r.calidad || {})) if (n <= 2) m.push(`${CATEGORIAS.find((c) => c.clave === k)?.nombre || k}: ${n}/5`);
    if ((r.noGusto || []).length) m.push('No le gustó un producto');
    if (r.repartidor && r.repartidor.valor === 'mal') m.push('Repartidor: mal');
    return m;
}

async function contestar(token, body) {
    const e = await Encuesta.findOne({ token: String(token || '') });
    if (!e) { const err = new Error('Encuesta no encontrada'); err.status = 404; throw err; }
    if (e.respondidaAt) { const err = new Error('Esta encuesta ya fue contestada. ¡Gracias!'); err.status = 409; throw err; }

    const respuestas = limpiarRespuestas(e, body && body.respuestas);
    const motivos = motivosDeMala(respuestas);
    const regalo = await regaloActual();
    const ahora = new Date();

    // Solo una vez, aunque lleguen dos envíos al mismo tiempo.
    const r = await Encuesta.updateOne({ _id: e._id, respondidaAt: null }, {
        $set: {
            respondidaAt: ahora,
            respuestas,
            mala: motivos.length > 0,
            motivosMala: motivos,
            seguimiento: { estado: motivos.length ? 'pendiente' : null },
            regalo: { texto: regalo, estado: 'pendiente', venceAt: new Date(ahora.getTime() + DIAS_REGALO * 864e5) },
        },
    });
    if (!r.modifiedCount) { const err = new Error('Esta encuesta ya fue contestada. ¡Gracias!'); err.status = 409; throw err; }

    // Correo nuevo (cuando la encuesta llegó por otro canal): se guarda si la ficha no tiene.
    const nuevo = String((body && body.email) || '').trim().toLowerCase();
    if (emailValido(nuevo) && !emailValido(e.email)) {
        await Clientes.updateOne({ telefono: { $regex: `${e.telefono}$` }, $or: [{ email: null }, { email: '' }] }, { $set: { email: nuevo } }).catch(() => {});
    }

    const fresca = await Encuesta.findById(e._id).lean();
    avisarEquipo(fresca).catch((err) => console.error('❌ Aviso de encuesta a Telegram:', err.message));
    return { regalo, venceAt: fresca.regalo.venceAt, diasRegalo: DIAS_REGALO };
}

// ---------------------------------------------------------------------------
// Aviso al equipo (Telegram)
// ---------------------------------------------------------------------------
const destinosEquipo = () => {
    const g = String(process.env.TELEGRAM_GRUPO_EQUIPO || '').trim();
    return g ? [g] : String(process.env.TELEGRAM_ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
};
const estrellas = (n) => '⭐'.repeat(n) + '☆'.repeat(5 - n);
const NOMBRE_OPCION = Object.fromEntries(PREGUNTAS.flatMap((p) => (p.opciones || []).map((o) => [`${p.id}.${o.v}`, o.t])));

function textoAviso(e) {
    const E = tg.escaparHTML;
    const r = e.respuestas || {};
    const l = [
        e.mala ? '🔴 <b>Encuesta con problema</b> — hay que darle seguimiento' : '🟢 <b>Encuesta contestada</b>',
        '',
        `👤 ${E(e.nombre || '')} · ${E(e.telefono)}`,
        `📦 Entrega: ${E(e.fechaEntrega || e.entregaISO)}${e.repartidor ? ` · 🚚 ${E(e.repartidor)}` : ''}`,
        '',
        `General: ${estrellas(r.general || 0)} (${r.general}/5)`,
    ];
    if (r.recomendacion != null) l.push(`Recomendaría: ${r.recomendacion}/10`);
    if (r.completo) l.push(r.completo.valor === 'si' ? '✅ Llegó completo' : `❌ Faltó: ${E(r.completo.detalle || '(no dijo qué)')}`);
    const cal = Object.entries(r.calidad || {});
    if (cal.length) l.push(`Calidad: ${cal.map(([k, n]) => `${NOMBRE_CATEGORIA[k] || k} ${n}/5`).join(' · ')}`);
    for (const x of r.noGusto || []) l.push(`👎 No le gustó: ${E(x.nombre)}${x.motivo ? ` — ${E(x.motivo)}` : ''}`);
    if (r.repartidor) l.push(`🚚 Repartidor: ${E(NOMBRE_OPCION[`repartidor.${r.repartidor.valor}`] || r.repartidor.valor)}${r.repartidor.detalle ? ` — ${E(r.repartidor.detalle)}` : ''}`);
    if (r.volver) {
        const v = r.volver.valores.map((x) => NOMBRE_OPCION[`volver.${x}`] || x);
        if (r.volver.otro) v.push(r.volver.otro);
        l.push(`🔁 Para pedir cada semana: ${E(v.join(', '))}`);
    }
    if (r.deseado) l.push(`🛒 Le gustaría: ${E(r.deseado)}`);
    if (r.comentario) l.push(`💬 ${E(r.comentario)}`);
    l.push('', `🎁 Ganó: ${E(e.regalo.texto)} (se agrega solo a su próximo pedido, hasta el ${new Date(e.regalo.venceAt).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short' })})`);
    return l.join('\n');
}

async function avisarEquipo(e) {
    if (!tg.hayToken()) return;
    for (const d of destinosEquipo()) {
        const r = await tg.enviarMensaje({ chatId: d, texto: textoAviso(e), disableNotification: !e.mala });
        if (!r.ok) console.log(`Encuestas: no pude avisar a ${d}: ${r.desc || r.tipo}`);
    }
}

// ---------------------------------------------------------------------------
// Regalo en el siguiente pedido
// ---------------------------------------------------------------------------
/**
 * Aparta el regalo pendiente (si hay) del cliente para el pedido que se está
 * creando. Atómico: si la tienda manda dos pedidos de un checkout a la vez, solo
 * uno se lo lleva. Devuelve la encuesta (con regalo.texto) o null.
 */
async function reclamarRegalo(telefono) {
    const t = tel10(telefono);
    if (!t) return null;
    return Encuesta.findOneAndUpdate(
        { telefono: t, 'regalo.estado': 'pendiente', 'regalo.venceAt': { $gt: new Date() } },
        { $set: { 'regalo.estado': 'aplicado', 'regalo.aplicadoAt': new Date() } },
        { new: true, sort: { respondidaAt: 1 } },
    ).lean();
}
const confirmarRegalo = (encuestaId, pedidoId) => Encuesta.updateOne({ _id: encuestaId }, { $set: { 'regalo.pedidoId': pedidoId } });
const devolverRegalo = (encuestaId) => Encuesta.updateOne({ _id: encuestaId }, { $set: { 'regalo.estado': 'pendiente', 'regalo.aplicadoAt': null } });

/** Regalo pendiente de un cliente (para avisar en el panel al capturar). */
async function regaloPendiente(telefono) {
    const t = tel10(telefono);
    if (!t) return null;
    const e = await Encuesta.findOne({ telefono: t, 'regalo.estado': 'pendiente', 'regalo.venceAt': { $gt: new Date() } }, { regalo: 1 }).lean();
    return e ? { texto: e.regalo.texto, venceAt: e.regalo.venceAt } : null;
}

// ---------------------------------------------------------------------------
// Resumen para el panel
// ---------------------------------------------------------------------------
async function resumen(desde) {
    const filtro = desde ? { createdAt: { $gte: new Date(`${desde}T06:00:00Z`) } } : {};
    const todas = await Encuesta.find(filtro, { respuestas: 1, respondidaAt: 1, mala: 1, 'envio.ok': 1, 'regalo.estado': 1, seguimiento: 1 }).lean();
    const resp = todas.filter((e) => e.respondidaAt);
    const prom = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

    const calidad = {};
    for (const c of CATEGORIAS) {
        const xs = resp.map((e) => e.respuestas?.calidad?.[c.clave]).filter((n) => n != null);
        if (xs.length) calidad[c.clave] = { nombre: `${c.emoji} ${c.nombre}`, promedio: prom(xs), respuestas: xs.length };
    }
    const recs = resp.map((e) => e.respuestas?.recomendacion).filter((n) => n != null);
    const nps = recs.length ? Math.round(((recs.filter((n) => n >= 9).length - recs.filter((n) => n <= 6).length) / recs.length) * 100) : null;

    const contar = (pares) => Object.entries(pares.reduce((a, k) => { a[k] = (a[k] || 0) + 1; return a; }, {}))
        .map(([nombre, veces]) => ({ nombre, veces })).sort((a, b) => b.veces - a.veces);

    return {
        enviadas: todas.filter((e) => e.envio && e.envio.ok).length,
        contestadas: resp.length,
        malas: resp.filter((e) => e.mala).length,
        pendientesSeguimiento: resp.filter((e) => e.seguimiento && e.seguimiento.estado === 'pendiente').length,
        regalosUsados: todas.filter((e) => e.regalo && e.regalo.estado === 'aplicado').length,
        general: prom(resp.map((e) => e.respuestas?.general).filter((n) => n != null)),
        nps,
        completo: resp.filter((e) => e.respuestas?.completo?.valor === 'si').length,
        incompleto: resp.filter((e) => e.respuestas?.completo?.valor === 'no').length,
        calidad,
        noGusto: contar(resp.flatMap((e) => (e.respuestas?.noGusto || []).map((x) => x.nombre))).slice(0, 15),
        repartidor: contar(resp.map((e) => e.respuestas?.repartidor?.valor).filter(Boolean).map((v) => NOMBRE_OPCION[`repartidor.${v}`] || v)),
        volver: contar(resp.flatMap((e) => e.respuestas?.volver?.valores || []).map((v) => NOMBRE_OPCION[`volver.${v}`] || v)),
    };
}

module.exports = {
    PREGUNTAS, CATEGORIAS, NOMBRE_OPCION, VERSION, REGALO_DEFAULT, DIAS_REGALO,
    fechaAISO, hoyMX, sumarDias,
    candidatos, productosDe, enviarRango, estadoEnvio, programarEnvioDiario,
    paraContestar, contestar, preguntasPara,
    reclamarRegalo, confirmarRegalo, devolverRegalo, regaloPendiente,
    resumen, regaloActual, leerConfig,
    _pruebas: { limpiarRespuestas, motivosDeMala, textoAviso },
};
