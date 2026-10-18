/**
 * Entrega del PDF de lista de precios por Telegram, con caché.
 *
 * Generar el PDF tarda ~12 s (~50 s la primera vez, mientras se bajan las
 * fotos). Para no hacer esperar a cada cliente:
 *   - se calcula la huella del catálogo (precios, nombres, fotos);
 *   - si coincide con la del último PDF enviado, se reenvía por su file_id de
 *     Telegram, que es instantáneo y no vuelve a subir nada;
 *   - si cambió algo, se genera, se sube y se guarda el nuevo file_id.
 * El file_id vive en la colección Config, así que sobrevive a un redeploy.
 */

const Config = require('../models/Config');
const L = require('./listaPdf');
const tg = require('./telegram');

const CLAVE = 'telegram_lista_pdf';          // caché del PDF generado
const CLAVE_MANUAL = 'telegram_lista_manual';  // el PDF de Canva que sube el dueño
const { proximoCierre } = require('./telegramPedidos');

/**
 * Quién puede cambiar la lista: ids de usuario de Telegram separados por coma
 * en TELEGRAM_ADMIN_IDS. Se lee en cada llamada (ver utils/entorno.js).
 */
const esAdmin = (userId) => String(process.env.TELEGRAM_ADMIN_IDS || '')
    .split(',').map((x) => x.trim()).filter(Boolean).includes(String(userId));
const admins = () => String(process.env.TELEGRAM_ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
let generando = null;   // si dos clientes la piden a la vez, se genera una sola vez

async function leer(clave) {
    try {
        const c = await Config.findOne({ key: clave }).lean();
        return c ? JSON.parse(c.value) : null;
    } catch (e) {
        return null;
    }
}

async function guardar(clave, datos) {
    await Config.findOneAndUpdate(
        { key: clave },
        { value: JSON.stringify(datos), updatedAt: new Date() },
        { upsert: true },
    );
}
const leerCache = () => leer(CLAVE);
const guardarCache = (d) => guardar(CLAVE, d);

/** La lista manual vigente (subida hace menos de 7 días), o null. */
async function listaManualVigente() {
    const m = await leer(CLAVE_MANUAL);
    if (!m || !m.fileId) return { vigente: null, vencida: null };
    // Vale hasta el cierre de la semana en que se subió (viernes 7 PM). Una lista
    // subida el fin de semana, con los pedidos cerrados, vale para la semana que viene.
    const vence = m.vence ? new Date(m.vence) : proximoCierre(new Date(m.subidoAt));
    return Date.now() < vence.getTime() ? { vigente: m, vencida: null } : { vigente: null, vencida: m };
}

const fechaCorta = (d) => new Date(d).toLocaleDateString('es-MX', {
    timeZone: 'America/Mexico_City', weekday: 'long', day: 'numeric', month: 'long',
});

/**
 * Guarda como lista vigente un PDF que mandó un admin al bot.
 * Telegram deja reenviar el archivo por su file_id: no hace falta descargarlo
 * ni guardarlo en ningún sitio.
 */
async function guardarListaManual({ fileId, nombre, userId, nombreAdmin }) {
    const ahora = new Date();
    const datos = { fileId, nombre, subidoAt: ahora, vence: proximoCierre(ahora), subidoPor: String(userId), nombreAdmin, avisoVencida: false };
    await guardar(CLAVE_MANUAL, datos);
    console.log(`📄 Lista manual actualizada por ${nombreAdmin || userId}: ${nombre}`);
    return datos;
}

async function quitarListaManual() {
    await Config.deleteOne({ key: CLAVE_MANUAL });
}

/**
 * Si la lista de Canva venció y alguien pidió la lista, se avisa una vez a los
 * admins: así se enteran de que tocaba subir la nueva.
 */
async function avisarVencida(vencida) {
    if (!vencida || vencida.avisoVencida) return;
    await guardar(CLAVE_MANUAL, { ...vencida, avisoVencida: true });
    for (const id of admins()) {
        await tg.enviarMensaje({
            chatId: id,
            texto: '⏰ <b>La lista de precios de Canva venció</b> (se subió el ' + fechaCorta(vencida.subidoAt) + ').\n\n' +
                'Mientras tanto estoy mandando la lista generada con los precios del panel. ' +
                'Para poner la de esta semana, mándame el PDF con el texto <code>/lista</code>.',
        }).catch(() => {});
    }
}

function pie(generadoAt) {
    const fecha = new Date(generadoAt).toLocaleDateString('es-MX', {
        timeZone: 'America/Mexico_City', day: 'numeric', month: 'long',
    });
    return `📄 <b>Lista de precios</b> al ${fecha}\n\n` +
        'Escríbeme lo que quieras pedir, o mándame una foto de tu lista 🛒';
}

/**
 * Manda la lista al chat. Devuelve { ok, desdeCache }.
 * @param avisar  función opcional para decir "dame unos segundos" si hay que generarla
 */
async function enviarLista(chatId, { avisar } = {}) {
    // 1) La de Canva, si se subió en los últimos 7 días.
    const { vigente, vencida } = await listaManualVigente();
    if (vigente) {
        const r = await tg.enviarDocumento({
            chatId, documento: vigente.fileId,
            pie: '📄 <b>Lista de precios de la semana</b>\n\nEscríbeme lo que quieras pedir, o mándame una foto de tu lista 🛒',
        });
        if (r.ok) return { ok: true, origen: 'manual' };
        console.warn('⚠️ lista manual: no se pudo reenviar, uso la generada:', r.desc);
    }
    avisarVencida(vencida).catch(() => {});

    // 2) Si no, la generada desde el panel.
    const huella = await L.huellaActual();
    const cache = await leerCache();

    if (cache && cache.huella === huella && cache.fileId) {
        const r = await tg.enviarDocumento({ chatId, documento: cache.fileId, pie: pie(cache.generadoAt) });
        if (r.ok) return { ok: true, origen: 'generada', desdeCache: true };
        // file_id inválido (otro bot, archivo caducado): se regenera abajo.
        console.warn('⚠️ lista: file_id en caché no sirvió:', r.desc);
    }

    if (avisar) await avisar();
    await tg.enviarAccion(chatId, 'upload_document');

    if (!generando) {
        generando = L.generarDesdeBase().finally(() => { generando = null; });
    }
    const pdf = await generando;
    const fecha = new Date(pdf.generadoAt).toISOString().slice(0, 10);
    const r = await tg.enviarDocumento({
        chatId, documento: pdf.buffer, nombre: `Lista Fresh Market ${fecha}.pdf`, pie: pie(pdf.generadoAt),
    });
    if (r.ok && r.fileId) {
        await guardarCache({ huella: pdf.huella, fileId: r.fileId, generadoAt: pdf.generadoAt, paginas: pdf.paginas });
        console.log(`📄 Lista generada y enviada: ${pdf.paginas} págs, ${(pdf.buffer.length / 1048576).toFixed(1)} MB`);
    }
    return { ok: r.ok, origen: 'generada', desdeCache: false, desc: r.desc };
}

// ---------------------------------------------------------------------------
// Imágenes de la semana (promociones y regalos, las de Canva)
// ---------------------------------------------------------------------------

const TIPOS_IMAGEN = {
    promos: { clave: 'telegram_img_promos', titulo: 'Promociones de la semana' },
    regalos: { clave: 'telegram_img_regalos', titulo: 'Regalos de la semana' },
};

/** Guarda la imagen que mandó un admin. Vale hasta el próximo cierre del viernes. */
async function guardarImagenSemana(tipo, { fileId, userId, nombreAdmin }) {
    const t = TIPOS_IMAGEN[tipo];
    const ahora = new Date();
    await guardar(t.clave, { fileId, subidoAt: ahora, vence: proximoCierre(ahora), subidoPor: String(userId), nombreAdmin });
    console.log(`🖼️ ${t.titulo} actualizada por ${nombreAdmin || userId}`);
}

/** file_id de la imagen vigente de ese tipo, o null si no hay o ya venció. */
async function imagenSemana(tipo) {
    const m = await leer(TIPOS_IMAGEN[tipo].clave);
    if (!m || !m.fileId || Date.now() >= new Date(m.vence).getTime()) return null;
    return { fileId: m.fileId, titulo: TIPOS_IMAGEN[tipo].titulo, vence: m.vence };
}

module.exports = {
    enviarLista, guardarListaManual, quitarListaManual, listaManualVigente, esAdmin,
    guardarImagenSemana, imagenSemana, TIPOS_IMAGEN,
};
