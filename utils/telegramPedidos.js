/**
 * Cálculo de pedidos hechos por chat (bot de Telegram).
 *
 * Regla de oro: la IA NUNCA calcula precios. Decide QUÉ quiere el cliente
 * (despensa, cambios, productos, fecha) usando códigos cortos, y este módulo
 * calcula el total con los precios de la base de datos. Una alucinación del
 * modelo puede, como mucho, proponer algo inválido — que aquí se rechaza —,
 * pero nunca cobrar de más o de menos.
 *
 * Replica las reglas de la tienda (fresh-market-order) para que un pedido por
 * chat valga exactamente lo mismo que por la web:
 *   - cada producto de una despensa vale su precio de catálogo
 *     (hooks/useProducts.jsx: `price: p.productId.price`)
 *   - máximo 3 cambios por despensa, y solo si `allowChanges`
 *     (pages/CustomizePage.jsx: `swapsCount >= 3`)
 *   - total despensa = base + Σ(precio pone − precio quita) + extras, y NUNCA
 *     por debajo del precio base: si los cambios lo bajan, hay que completar con
 *     productos (useOrder.jsx: priceDeficit / canConfirmChanges)
 *   - productos sueltos: precio × veces; mínimo $320 si no hay despensa ese día
 *     (constants/index.js: MIN_CUSTOM_ORDER = 320)
 *   - envío una sola vez, en el primer pedido; gratis en jueves solo en zona
 *     azul (utils/buildPedidos.js: calcEnvio)
 *   - días de entrega: los de app-config, sin domingo, sin hoy, y después de
 *     las 8 PM ya no entra mañana (components/delivery/deliveryUtils.js)
 *
 * Todo lo de aquí son funciones puras salvo `cargarSnapshot`, para poder
 * probarlas sin base de datos (test/telegramPedidos.test.js).
 */

const MAX_CAMBIOS = 3;
const MINIMO_PERSONALIZADO = 320;
const HORA_CORTE = 20;               // 8 PM, hora de Pachuca
const DIAS_SOLO_INTERNOS = ['domingo'];
const DIAS_ID = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const normalizar = (s) => String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const dinero = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-MX');

/**
 * Busca una despensa por nombre tolerando cómo la escriba la IA o el cliente:
 * "Especial", "especial", "Despensa Especial", "la especial".
 */
function buscarDespensa(snap, nombre) {
    const n = normalizar(nombre).replace(/^(la|el)\s+/, '').replace(/^despensa\s+/, '').trim();
    return snap.despensas[n] || null;
}

// ---------------------------------------------------------------------------
// Hora de Pachuca
// ---------------------------------------------------------------------------

function ahoraMX(fecha = new Date()) {
    const p = {};
    for (const { type, value } of new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', hour12: false,
    }).formatToParts(fecha)) p[type] = value;
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24 };
}

/** "sábado, 17 Octubre 2026" -> { dia: 'sabado', y, m, d } o null. */
function leerFecha(texto) {
    const t = normalizar(texto);
    const m = t.match(/^([a-z]+),?\s+(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);
    if (!m) return null;
    const mes = MESES.indexOf(m[3]);
    if (mes === -1) return null;
    return { dia: m[1], y: +m[4], m: mes + 1, d: +m[2] };
}

/**
 * Días de entrega que el cliente puede elegir ahora mismo.
 * `fechasConfig` son las que el admin captura en el panel (app-config).
 */
function fechasDisponibles(fechasConfig = [], ahora = new Date()) {
    const hoy = ahoraMX(ahora);
    const hoyNum = Date.UTC(hoy.y, hoy.m - 1, hoy.d);
    const manana = hoyNum + 86400000;

    return (fechasConfig || []).filter((f) => {
        const x = leerFecha(f);
        if (!x) return false;
        if (DIAS_SOLO_INTERNOS.includes(x.dia)) return false;
        const n = Date.UTC(x.y, x.m - 1, x.d);
        if (n <= hoyNum) return false;                           // ya pasó, o es hoy
        if (n === manana && hoy.h >= HORA_CORTE) return false;   // después de las 8 PM
        return true;
    });
}

// ---------------------------------------------------------------------------
// Cierre semanal
// ---------------------------------------------------------------------------
// Los pedidos de la semana cierran el VIERNES a las 7 PM y las opciones nuevas
// (despensas y lista de precios) salen el LUNES a las 11 AM, hora de Pachuca.
// Si el admin marca las despensas como listas antes (el mismo interruptor que
// usa la tienda: AppConfig.despensasListasAt), se abre en ese momento.
const CIERRE = { dia: 5, hora: 19 };     // viernes 7 PM
const APERTURA = { dia: 1, hora: 11 };   // lunes 11 AM

/** Día de la semana (0=domingo) y hora de un instante, en hora de Pachuca. */
function diaHoraMX(fecha) {
    const p = {};
    for (const { type, value } of new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Mexico_City', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(fecha)) p[type] = value;
    const dia = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
    return { dia, minutos: (+p.hour % 24) * 60 + (+p.minute) };
}

/** Minutos desde el domingo 00:00 de su semana (0 … 10079). */
const minutoSemanal = (f) => { const x = diaHoraMX(f); return x.dia * 1440 + x.minutos; };
const M_CIERRE = CIERRE.dia * 1440 + CIERRE.hora * 60;      // viernes 19:00
const M_APERTURA = APERTURA.dia * 1440 + APERTURA.hora * 60; // lunes 11:00

/**
 * ¿Están cerrados los pedidos ahora?
 * Cerrado de viernes 19:00 a lunes 11:00, salvo que el admin haya marcado las
 * despensas como listas DESPUÉS de que empezó este cierre.
 */
function pedidosCerrados(ahora = new Date(), despensasListasAt = null) {
    const m = minutoSemanal(ahora);
    const enCierre = m >= M_CIERRE || m < M_APERTURA;
    if (!enCierre) return false;
    if (despensasListasAt) {
        // Minutos transcurridos desde que empezó el cierre actual.
        const desdeCierre = m >= M_CIERRE ? m - M_CIERRE : m + (10080 - M_CIERRE);
        const inicio = ahora.getTime() - desdeCierre * 60000;
        if (new Date(despensasListasAt).getTime() >= inicio) return false;
    }
    return true;
}

/** Próximo cierre (viernes 19:00 MX) posterior a `desde`. */
function proximoCierre(desde = new Date()) {
    const m = minutoSemanal(desde);
    let faltan = M_CIERRE - m;
    if (faltan <= 0) faltan += 10080;
    const t = new Date(desde.getTime() + faltan * 60000);
    t.setUTCSeconds(0, 0);
    return t;
}

const esJueves = (fecha) => normalizar(fecha).startsWith('jueves');
const calcEnvio = (costoEnvio, gratisJueves, fecha) =>
    (esJueves(fecha) && gratisJueves) ? 0 : (Number(costoEnvio) || 0);

/**
 * Pueblos fuera de Pachuca: se entrega SOLO los viernes, sin costo, en un punto
 * fijo. Acayuca va antes que Zapotlán porque pertenece a ese municipio y las
 * direcciones suelen traer los dos nombres.
 */
const PUEBLOS = [
    { clave: 'acayuca', nombre: 'Acayuca', patron: /acayuca/, lugar: 'el kiosko', horario: 'de 12:00 a 1:00 pm' },
    { clave: 'zapotlan', nombre: 'Zapotlán', patron: /zapotlan/, lugar: 'la presidencia', horario: 'de 12:30 a 1:30 pm' },
    { clave: 'tolcayuca', nombre: 'Tolcayuca', patron: /tolcayuca/, lugar: 'la presidencia', horario: 'de 1:00 a 2:00 pm' },
    { clave: 'tizayuca', nombre: 'Tizayuca', patron: /tizayuca/, lugar: 'la Parroquia del Divino Salvador (Centro)', mapa: 'https://maps.app.goo.gl/oY9D8sHsyYZQ4nGC7', horario: 'de 2:00 a 4:00 pm (los repartidores suelen llegar 2:30 y quedarse hasta 4:00–4:30)' },
];
const DIA_PUEBLOS = 'viernes';

/** ¿La dirección (o el nombre de la ficha, que a veces lleva " - Tizayuca") es de un pueblo? */
function puebloDe(...textos) {
    const t = normalizar(textos.filter(Boolean).join(' '));
    return PUEBLOS.find((p) => p.patron.test(t)) || null;
}
const textoPueblo = (p) => `${DIA_PUEBLOS} en ${p.lugar} de ${p.nombre}, ${p.horario}${p.mapa ? `. Ubicación: ${p.mapa}` : ''}`;

// ---------------------------------------------------------------------------
// Snapshot del catálogo
// ---------------------------------------------------------------------------

/**
 * Foto fija del catálogo al empezar una conversación.
 *
 * Se congela por conversación por dos motivos: los códigos cortos (P12, D3)
 * tienen que significar lo mismo todo el rato, y el modelo (Haiku 5.5) invalida
 * su razonamiento previo si cambia el prompt de sistema a media conversación.
 * Los PRECIOS, en cambio, se vuelven a leer de la base al cotizar.
 *
 * Códigos cortos en vez de ObjectIds: 362 ids de 24 caracteres serían miles de
 * tokens de puro ruido en cada mensaje.
 */
/**
 * Productos de peso variable (papaya, pollo entero, pavo…): en el panel van con
 * precio $0 y "PENDIENTE PRECIO" en el nombre, con el precio por kilo de
 * referencia ("1 Papaya $34 kg PENDIENTE PRECIO"). Se venden igual; el precio
 * final lo pone el equipo al pesarlos.
 */
const PENDIENTE_PRECIO = /pendiente\s+precio/i;
function datosPrecioPendiente(title) {
    const t = String(title || '');
    const m = t.match(/\$\s*(\d+(?:\.\d+)?)\s*(?:x\s*)?(kg|kilo|pza|pieza)?/i);
    const limpio = t.replace(PENDIENTE_PRECIO, '').replace(/\s*\$\s*\d+(?:\.\d+)?\s*(?:x\s*)?(kg|kilo|pza|pieza)?\s*/i, ' ')
        .replace(/\s+/g, ' ').trim();
    const referencia = m ? `$${m[1]}${m[2] ? ` el ${/^k/i.test(m[2]) ? 'kg' : 'pieza'}` : ''}` : '';
    return { limpio, referencia };
}

function construirSnapshot({ productos = [], despensas = [] }) {
    const visibles = productos
        .filter((p) => p.showInWeb !== false && p.inStock !== false
            && (Number(p.price) > 0 || PENDIENTE_PRECIO.test(p.title || '')))
        .sort((a, b) => String(a.title).localeCompare(String(b.title), 'es'));

    const prods = {};
    visibles.forEach((p, i) => {
        const pendiente = !(Number(p.price) > 0);
        const pp = pendiente ? datosPrecioPendiente(p.title) : null;
        prods['P' + (i + 1)] = {
            id: String(p._id), title: pendiente ? pp.limpio : String(p.title).trim(), price: Number(p.price) || 0,
            ...(pendiente ? { precioPendiente: true, referencia: pp.referencia } : {}),
            minUnit: Number(p.minUnit) || 1, unit: p.unit || '',
            categoria: (p.categories && p.categories[0]) || 'Otros',
            img: p.img || null,
        };
    });

    const desps = {};
    despensas
        .filter((d) => d.showInWeb !== false && Number(d.price) > 0)
        .sort((a, b) => a.price - b.price)
        .forEach((d) => {
            desps[normalizar(d.name)] = {
                id: String(d._id), nombre: d.name, base: Number(d.price),
                permiteCambios: d.allowChanges !== false,
                img: d.img || null,
                items: (d.products || []).map((it, i) => ({
                    codigo: 'D' + (i + 1),
                    productId: it.productId && String(it.productId._id || it.productId),
                    title: (it.productId && it.productId.title) ? String(it.productId.title).trim() : '(producto)',
                    price: (it.productId && Number(it.productId.price)) || 0,
                    cantidad: it.cantidad, unidad: it.unidad,
                })),
            };
        });

    return { productos: prods, despensas: desps };
}

/** Texto del catálogo para el prompt, agrupado por categoría. */
function textoCatalogo(snap) {
    const partes = ['DESPENSAS (precio base; cada producto vale su precio de catálogo):'];
    for (const d of Object.values(snap.despensas)) {
        partes.push(`\n## Despensa ${d.nombre} — ${dinero(d.base)}${d.permiteCambios ? '' : ' (NO admite cambios)'}`);
        for (const it of d.items) partes.push(`${it.codigo}. ${it.title} [vale ${dinero(it.price)}]`);
    }

    partes.push('\nPRODUCTOS (código. nombre tal como se vende — precio por unidad de venta):');
    const porCat = {};
    for (const [codigo, p] of Object.entries(snap.productos)) (porCat[p.categoria] = porCat[p.categoria] || []).push([codigo, p]);
    for (const cat of Object.keys(porCat).sort()) {
        partes.push(`\n## ${cat}`);
        for (const [codigo, p] of porCat[cat]) {
            partes.push(p.precioPendiente
                ? `${codigo}. ${p.title} — precio según su peso${p.referencia ? ` (aprox. ${p.referencia})` : ''}, se confirma al surtir el pedido`
                : `${codigo}. ${p.title} — ${dinero(p.price)}`);
        }
    }
    return partes.join('\n');
}

// ---------------------------------------------------------------------------
// Cotización
// ---------------------------------------------------------------------------

class ErrorPedido extends Error {}

/**
 * Valida y calcula un pedido. No escribe nada.
 *
 * @param solicitud  lo que propone la IA:
 *   { despensas: [{ nombre, cantidad?, cambios?: [{quitar:'D3', poner:'P41'}], extras?: [{codigo, cantidad}] }],
 *     productos: [{ codigo, cantidad }], fecha, direccion: 'principal' | número, nota? }
 * @param ctx  { snap, preciosActuales: { [productId]: price }, cliente, fechasValidas }
 */
/**
 * Regalos por comprar varias despensas en el mismo pedido. Réplica de la tienda
 * (fresh-market-order hooks/useOrder.jsx `giftInfo` y GiftSelectionModal):
 *   - 2 o 3 despensas → 1 regalo; 4 o más → 2 regalos, o el descuento de $50
 *   - si TODAS son Premium o Parrillera, los regalos son los de nivel 2
 * Las opciones salen de AppConfig.regalos, que el equipo edita en el panel.
 */
function regalosPorDespensas(nombresDespensas, regalosConfig) {
    const total = nombresDespensas.length;
    const premium = nombresDespensas.filter((n) => /premium|parrillera/i.test(n)).length;
    const nivel = total > 0 && premium === total ? 2 : 1;
    const cantidad = total >= 4 ? 2 : total >= 2 ? 1 : 0;
    if (!cantidad) return { cantidad: 0, nivel: 0, opciones: [] };
    const limpio = (r) => String(r.nombre || '').trim();
    const opciones = regalosConfig.filter((r) => r.unidad !== 'descuento' && (r.tier || 1) === nivel).map(limpio);
    const descuento = regalosConfig.find((r) => r.unidad === 'descuento');
    if (total >= 4 && descuento) opciones.push(limpio(descuento));
    return { cantidad, nivel, opciones };
}

function cotizar(solicitud, ctx) {
    const { snap, preciosActuales = {}, cliente, fechasValidas = [] } = ctx;
    const avisos = [];
    const precioDe = (id, respaldo) => {
        const p = preciosActuales[id];
        return Number.isFinite(p) && p > 0 ? p : respaldo;
    };
    const producto = (codigo) => {
        const p = snap.productos[String(codigo || '').toUpperCase().trim()];
        if (!p) throw new ErrorPedido(`No existe el producto con código ${codigo}.`);
        if (!(p.id in preciosActuales)) throw new ErrorPedido(`${p.title} ya no está disponible.`);
        const precio = precioDe(p.id, p.price);
        if (p.precioPendiente) {
            if (precio > 0) return { ...p, price: precio, precioPendiente: false };   // ya le pusieron precio
            porConfirmar.push(p);
            return p;
        }
        if (precio !== p.price) avisos.push(`El precio de ${p.title} cambió a ${dinero(precio)}.`);
        return { ...p, price: precio };
    };
    const porConfirmar = [];
    const precioTexto = (p, n = 1) => (p.precioPendiente
        ? `precio según su peso${p.referencia ? ` (aprox. ${p.referencia})` : ''}`
        : dinero(p.price * n));
    const veces = (n) => {
        const v = Math.round(Number(n));
        if (!Number.isFinite(v) || v < 1 || v > 50) throw new ErrorPedido('Cada cantidad debe ser un número entre 1 y 50.');
        return v;
    };

    // --- dirección ---
    let dir;
    if (solicitud.direccion === undefined || solicitud.direccion === 'principal' || solicitud.direccion === 0) {
        dir = { texto: cliente.direccion, gps: cliente.gpsLink || '', colonia: cliente.colonia || '', cp: cliente.cp || '',
            costoEnvio: cliente.costoEnvio, gratisJueves: cliente.gratisJueves, indice: 0 };
    } else {
        const i = Number(solicitud.direccion) - 1;
        const d = (cliente.misDirecciones || [])[i];
        if (!d) throw new ErrorPedido('Esa dirección no existe en la ficha del cliente.');
        dir = { texto: d.direccion, gps: d.gpsLink || '', colonia: d.colonia || '', cp: d.cp || '',
            costoEnvio: d.costoEnvio, gratisJueves: d.gratisJueves, indice: i + 1 };
    }

    // --- fecha --- (los pueblos solo reciben el viernes)
    const pueblo = puebloDe(dir.texto, dir.colonia, dir.indice === 0 ? cliente.nombre : '');
    const validas = pueblo ? fechasValidas.filter((f) => normalizar(f).startsWith(DIA_PUEBLOS)) : fechasValidas;
    const fecha = validas.find((f) => normalizar(f) === normalizar(solicitud.fecha));
    if (!fecha) {
        if (pueblo) {
            throw new ErrorPedido(validas.length
                ? `Para ${pueblo.nombre} solo entregamos el ${textoPueblo(pueblo)}. La fecha debe ser: ${validas.join(' / ')}.`
                : `Para ${pueblo.nombre} solo entregamos los viernes y por ahora no hay viernes disponible.`);
        }
        throw new ErrorPedido(validas.length
            ? `La fecha debe ser una de: ${validas.join(' / ')}.`
            : 'Ahora mismo no hay días de entrega disponibles.');
    }
    if (pueblo) dir.costoEnvio = 0;               // en el punto de entrega no se cobra envío

    const lineas = [];
    const payloads = [];

    // --- despensas ---
    const pedidoDespensas = [];
    for (const sd of solicitud.despensas || []) {
        const d = buscarDespensa(snap, sd.nombre);
        if (!d) throw new ErrorPedido(`No existe la despensa "${sd.nombre}". Disponibles: ${Object.values(snap.despensas).map((x) => x.nombre).join(', ')}.`);
        const cambios = sd.cambios || [];
        if (cambios.length && !d.permiteCambios) throw new ErrorPedido(`La despensa ${d.nombre} no admite cambios.`);
        if (cambios.length > MAX_CAMBIOS) throw new ErrorPedido(`Máximo ${MAX_CAMBIOS} cambios por despensa.`);

        const quitados = new Set();
        let diferencia = 0;
        const deleted = [];
        const nuevos = [];
        for (const c of cambios) {
            const it = d.items.find((x) => x.codigo === String(c.quitar || '').toUpperCase().trim());
            if (!it) throw new ErrorPedido(`En la despensa ${d.nombre} no hay un producto con código ${c.quitar}.`);
            if (quitados.has(it.codigo)) throw new ErrorPedido(`${it.title} se quitó dos veces.`);
            quitados.add(it.codigo);
            const pone = producto(c.poner);
            if (pone.precioPendiente) throw new ErrorPedido(`${pone.title} no puede ir como cambio porque su precio depende del peso; se puede agregar aparte.`);
            if (esPromo(pone)) throw new ErrorPedido(`${pone.title} es una promoción de la semana: no aplica como cambio en la despensa, pero sí se puede agregar aparte.`);
            const vale = precioDe(it.productId, it.price);
            diferencia += pone.price - vale;
            deleted.push({ id: it.productId, nombre: it.title, precio: Math.round(vale), cantidad: it.cantidad, unidad: it.unidad });
            nuevos.push({ _id: pone.id, title: pone.title, price: Math.round(pone.price) });
        }

        let extrasTotal = 0;
        for (const e of sd.extras || []) {
            const p = producto(e.codigo);
            const n = veces(e.cantidad);
            extrasTotal += p.price * n;
            for (let k = 0; k < n; k++) nuevos.push({ _id: p.id, title: p.title, price: Math.round(p.price) });
        }

        const total = d.base + diferencia + extrasTotal;
        if (total < d.base) {
            throw new ErrorPedido(
                `Con esos cambios la despensa ${d.nombre} queda en ${dinero(d.base + diferencia)}, ` +
                `por debajo de su precio de ${dinero(d.base)}. Faltan ${dinero(d.base - total)}: ` +
                'elige reemplazos de más valor o agrega productos a esa despensa.');
        }

        const n = veces(sd.cantidad || 1);
        for (let k = 0; k < n; k++) {
            pedidoDespensas.push({ despensa: d.nombre, total: Math.round(total), deletedProducts: deleted, newProducts: nuevos });
        }
        let linea = `• Despensa ${d.nombre}${n > 1 ? ` ×${n}` : ''} — ${dinero(total * n)}`;
        for (const x of deleted) linea += `\n   sin ${x.nombre}`;
        for (const c of cambios) linea += `\n   + ${snap.productos[String(c.poner).toUpperCase().trim()].title}`;
        for (const e of sd.extras || []) {
            const px = snap.productos[String(e.codigo).toUpperCase().trim()];
            linea += `\n   + ${px.title}${e.cantidad > 1 ? ' ×' + e.cantidad : ''}${px.precioPendiente ? ` (${precioTexto(px)})` : ''}`;
        }
        lineas.push(linea);
    }

    // --- productos sueltos ---
    let sueltosTotal = 0;
    const sueltos = [];
    for (const sp of solicitud.productos || []) {
        const p = producto(sp.codigo);
        const n = veces(sp.cantidad);
        sueltosTotal += p.price * n;
        for (let k = 0; k < n; k++) sueltos.push({ _id: p.id, title: p.title, price: Math.round(p.price) });
        lineas.push(`• ${p.title}${n > 1 ? ' ×' + n : ''} — ${precioTexto(p, n)}`);
    }
    if (!pedidoDespensas.length && !sueltos.length) throw new ErrorPedido('El pedido está vacío.');
    if (!pedidoDespensas.length) {
        const promo = (solicitud.productos || []).map((sp) => producto(sp.codigo)).find(esPromo);
        if (promo) throw new ErrorPedido(`${promo.title} es una promoción de la semana y solo aplica comprando cualquier despensa.`);
    }

    // --- regalos por despensas (mismas reglas que la tienda: hooks/useOrder.jsx giftInfo) ---
    const reg = regalosPorDespensas(pedidoDespensas.map((d) => d.despensa), ctx.regalos || []);
    const elegidos = [];
    for (const nombre of solicitud.regalos || []) {
        const r = reg.opciones.find((o) => normalizar(o) === normalizar(nombre))
            || reg.opciones.find((o) => normalizar(o).includes(normalizar(nombre)));
        if (!r) {
            throw new ErrorPedido(reg.cantidad
                ? `Ese regalo no aplica. Opciones: ${reg.opciones.join(' / ')}.`
                : 'Los regalos son a partir de 2 despensas en el mismo pedido.');
        }
        if (!elegidos.includes(r)) elegidos.push(r);
    }
    if (elegidos.length > reg.cantidad) throw new ErrorPedido(`Le toca${reg.cantidad > 1 ? 'n' : ''} ${reg.cantidad} regalo${reg.cantidad > 1 ? 's' : ''}, no más.`);
    const regaloPendiente = reg.cantidad > elegidos.length
        ? { faltan: reg.cantidad - elegidos.length, opciones: reg.opciones } : null;
    if (!pedidoDespensas.length && sueltosTotal < MINIMO_PERSONALIZADO) {
        throw new ErrorPedido(
            `Un pedido sin despensa tiene un mínimo de ${dinero(MINIMO_PERSONALIZADO)}; ` +
            `este suma ${dinero(sueltosTotal)}. Faltan ${dinero(MINIMO_PERSONALIZADO - sueltosTotal)}.`);
    }

    // --- documentos, en el formato de buildPedidos.js de la tienda ---
    for (const pd of pedidoDespensas) payloads.push({ ...pd, despensaQuantity: 1 });
    if (sueltos.length) {
        payloads.push({ despensa: 'Pedido', despensaQuantity: 1, total: Math.round(sueltosTotal), deletedProducts: [], newProducts: sueltos });
    }

    const envio = calcEnvio(dir.costoEnvio, dir.gratisJueves, fecha);
    const subtotal = payloads.reduce((a, p) => a + p.total, 0);

    const comunes = {
        cliente: cliente.nombre, direccion: dir.texto, telefono: cliente.telefono,
        gpsLink: dir.gps, colonia: dir.colonia, cp: dir.cp,
        costoEnvio: Number(dir.costoEnvio) || 0, gratisJueves: dir.gratisJueves === true,
        fecha, envio: 0, puntosUsados: 0, regalo: '', reposicion: '',
        nota: [pueblo ? `ENTREGA EN PUNTO: ${textoPueblo(pueblo)}` : '',
            porConfirmar.length ? `PRECIO POR CONFIRMAR (pesar): ${[...new Set(porConfirmar.map((x) => x.title))].join(', ')}` : '',
            String(solicitud.nota || '').slice(0, 300)]
            .filter(Boolean).join(' · '),
        editarPdf: false,
        vendedor: 'Fresh Market', regaloRuleta: '', regaloRuletaSpinId: '',
        via: 'telegram',
        fuente: 'telegram',
        utm: { source: 'telegram', medium: 'bot', campaign: 'chat' },
        aplicarPromo: false,
    };
    const documentos = payloads.map((p) => ({ ...comunes, ...p }));
    documentos[0].aplicarPromo = true;            // la promo se reclama una vez por compra
    if (elegidos.length) documentos[0].regalo = elegidos.join(', ');   // como la tienda: solo en el primero
    if (envio > 0) {                              // el envío se cobra una vez por entrega
        documentos[0].envio = envio;
        documentos[0].total += envio;
    }

    return {
        fecha, direccion: dir.texto, envio, subtotal, total: subtotal + envio,
        lineas, avisos, documentos, regaloPendiente,
        porConfirmar: [...new Set(porConfirmar.map((x) => x.title))],
        resumen: [
            ...lineas,
            ...(elegidos.length ? [`• 🎁 Regalo: ${elegidos.join(', ')}`] : []),
            `• Envío — ${envio > 0 ? dinero(envio) : pueblo ? 'gratis (punto de entrega)' : 'gratis'}`,
            `TOTAL: ${dinero(subtotal + envio)}${porConfirmar.length ? ' + lo que pese lo marcado "según su peso"' : ''}`,
            ...(pueblo
                ? [`Entrega: ${fecha}, en ${pueblo.lugar} de ${pueblo.nombre}, ${pueblo.horario}`]
                : [`Entrega: ${fecha}`, `Dirección: ${dir.texto}`]),
        ].join('\n'),
    };
}

// ---------------------------------------------------------------------------
// Fotos
// ---------------------------------------------------------------------------

const MAX_FOTOS = 10;

/** Productos de la categoría de promociones de la semana («Promociones 🎫»). */
const esPromo = (p) => /promoci/i.test(p.categoria || '');

/**
 * Qué fotos mandar para una petición del agente.
 * { todasLasDespensas?, despensas?: [nombre], productos?: [codigo], promociones? }
 */
function fotosPara(snap, pedido = {}) {
    const fotos = [];
    const despensas = pedido.todasLasDespensas
        ? Object.values(snap.despensas)
        : (pedido.despensas || []).map((n) => buscarDespensa(snap, n)).filter(Boolean);
    for (const d of despensas) {
        if (d.img) fotos.push({ foto: d.img, pie: `Despensa ${d.nombre} — ${dinero(d.base)}` });
    }
    const prods = [
        ...(pedido.promociones ? Object.values(snap.productos).filter(esPromo) : []),
        ...(pedido.productos || []).map((c) => snap.productos[String(c).toUpperCase().trim()]).filter(Boolean),
    ];
    for (const p of prods) {
        if (p.img) {
            fotos.push({ foto: p.img, pie: `${p.title.replace(/\s*\$\s*\d+\s*$/, '')} — ${p.precioPendiente
                ? `precio según su peso${p.referencia ? ` (aprox. ${p.referencia})` : ''}` : dinero(p.price)}` });
        }
    }
    return fotos.slice(0, MAX_FOTOS);
}

// ---------------------------------------------------------------------------
// Acceso a datos (lo único que toca la base)
// ---------------------------------------------------------------------------

async function cargarSnapshot() {
    const Product = require('../models/Product');
    const Despensas = require('../models/Despensas');
    const [productos, despensas] = await Promise.all([
        Product.find({}, 'title price minUnit unit categories inStock showInWeb img').lean(),
        Despensas.find({}).populate('products.productId', 'title price').lean(),
    ]);
    return construirSnapshot({ productos, despensas });
}

/** Precios vigentes de los productos visibles y en stock, por id. */
async function preciosActuales() {
    const Product = require('../models/Product');
    const docs = await Product.find({ showInWeb: { $ne: false }, inStock: { $ne: false } }, 'price').lean();
    const m = {};
    for (const d of docs) m[String(d._id)] = Number(d.price);
    return m;
}

module.exports = {
    MAX_CAMBIOS, MINIMO_PERSONALIZADO, HORA_CORTE,
    ErrorPedido, normalizar, dinero, regalosPorDespensas, PUEBLOS, puebloDe, textoPueblo, ahoraMX, leerFecha, fechasDisponibles, calcEnvio,
    pedidosCerrados, proximoCierre,
    construirSnapshot, textoCatalogo, cotizar, cargarSnapshot, preciosActuales,
    fotosPara, esPromo, MAX_FOTOS, buscarDespensa,
};
