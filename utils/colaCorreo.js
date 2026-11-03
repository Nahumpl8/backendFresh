/**
 * Envío de correos masivos por cola (correo de la semana y encuestas).
 *
 * - Cada destinatario queda en EnvioCorreo: un reinicio o un deploy no corta el
 *   envío; al volver, sigue con los pendientes y nadie lo recibe dos veces.
 * - Respeta el ritmo y el límite diario del proveedor. Si el proveedor dice
 *   "límite" o rechaza la sesión, se pausa una hora (o hasta mañana) en vez de
 *   quemar la lista marcando todo como fallido.
 * - Proveedor: MASIVO_SMTP_* (p. ej. Brevo). Sin eso, usa la cuenta de siempre
 *   (EMAIL_*, GoDaddy), con un ritmo más conservador.
 *
 * Cada tipo registra cómo se arma su correo: registrar(tipo, fn). La función
 * recibe (envio, lote) y devuelve { subject, html, text, headers, alEnviar } o
 * null para omitirlo.
 */
const nodemailer = require('nodemailer');
const { LoteCorreo, EnvioCorreo } = require('../models/EnvioCorreo');
const { esStaging } = require('./entorno');
const { correosDeBaja } = require('./bajasCorreo');

const conProveedorMasivo = () => Boolean(process.env.MASIVO_SMTP_HOST);
const porMinuto = () => Number(process.env.MASIVO_POR_MINUTO) || (conProveedorMasivo() ? 60 : 15);
const limiteDia = () => Number(process.env.MASIVO_LIMITE_DIA) || (conProveedorMasivo() ? 290 : 200);
const remitente = () => process.env.MASIVO_FROM || '"Fresh Market" <pedidos@freshmarket.mx>';
const PAUSA_MIN = 60;

let transporte = null;
function transport() {
    if (transporte) return transporte;
    if (esStaging()) return (transporte = nodemailer.createTransport({ jsonTransport: true }));
    const masivo = conProveedorMasivo();
    const port = Number(masivo ? process.env.MASIVO_SMTP_PORT || 587 : process.env.EMAIL_PORT);
    transporte = nodemailer.createTransport({
        host: masivo ? process.env.MASIVO_SMTP_HOST : process.env.EMAIL_HOST,
        port,
        secure: port === 465,
        auth: {
            user: masivo ? process.env.MASIVO_SMTP_USER : process.env.EMAIL_USER,
            pass: masivo ? process.env.MASIVO_SMTP_PASS : process.env.EMAIL_PASS,
        },
        pool: true, maxConnections: 1, maxMessages: 50,   // una sola sesión: no abrir un login por correo
    });
    return transporte;
}

const armadores = {};
const registrar = (tipo, fn) => { armadores[tipo] = fn; };

const estado = { pausaHasta: null, motivo: '', corriendo: false };

/** Inicio del día de hoy en México (UTC-6, sin horario de verano). */
const hoyMX = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const inicioDiaMX = () => new Date(`${hoyMX()}T06:00:00Z`);
const mananaMX = () => new Date(inicioDiaMX().getTime() + 864e5 + 5 * 60000);

const enviadosHoy = () => EnvioCorreo.countDocuments({ estado: 'enviado', enviadoAt: { $gte: inicioDiaMX() } });

/** Errores que no son culpa del destinatario: límite, sesión rechazada, servidor ocupado. */
function esTemporal(e) {
    const c = Number(e && e.responseCode);
    return (e && (e.code === 'EAUTH' || e.code === 'ECONNECTION' || e.code === 'ETIMEDOUT' || e.code === 'ESOCKET'))
        || [421, 450, 451, 452, 454].includes(c)
        || /limit|quota|too many|rate|exceed|throttl/i.test(String((e && (e.response || e.message)) || ''));
}

function pausar(motivo, hasta) {
    estado.pausaHasta = hasta || new Date(Date.now() + PAUSA_MIN * 60000);
    estado.motivo = motivo;
    if (transporte && transporte.close) { transporte.close(); transporte = null; }
    console.log(`⏸️ Correos masivos en pausa hasta ${estado.pausaHasta.toISOString()}: ${motivo}`);
}

async function enviarUno() {
    const envio = await EnvioCorreo.findOneAndUpdate(
        { estado: 'pendiente' },
        { $set: { estado: 'enviando', tomadoAt: new Date() }, $inc: { intentos: 1 } },
        { new: true, sort: { createdAt: 1 } },
    );
    if (!envio) return false;

    const marcar = (set) => EnvioCorreo.updateOne({ _id: envio._id }, { $set: set });
    try {
        if ((await correosDeBaja()).has(envio.to)) { await marcar({ estado: 'error', error: 'Dado de baja' }); return true; }
        const lote = await LoteCorreo.findById(envio.lote).lean();
        const armar = armadores[envio.tipo];
        const msg = lote && armar ? await armar(envio, lote) : null;
        if (!msg) { await marcar({ estado: 'error', error: 'Omitido' }); return true; }

        await transport().sendMail({ from: remitente(), to: envio.to, subject: msg.subject, html: msg.html, text: msg.text, headers: msg.headers });
        await marcar({ estado: 'enviado', enviadoAt: new Date(), error: '' });
        if (msg.alEnviar) await msg.alEnviar(true).catch(() => {});
    } catch (e) {
        const detalle = String(e.response || e.message || e).slice(0, 200);
        if (esTemporal(e)) {
            await marcar({ estado: 'pendiente', error: detalle });   // se reintenta al terminar la pausa
            pausar(detalle);
        } else {
            await marcar({ estado: envio.intentos >= 3 ? 'error' : 'pendiente', error: detalle });
        }
    }
    return true;
}

async function ciclo() {
    let espera = 30000;
    try {
        if (estado.pausaHasta && estado.pausaHasta > new Date()) {
            espera = Math.min(estado.pausaHasta - Date.now(), 10 * 60000);
        } else {
            estado.pausaHasta = null; estado.motivo = '';
            if (await enviadosHoy() >= limiteDia()) {
                pausar(`Límite diario de ${limiteDia()} correos; sigue mañana`, mananaMX());
            } else if (await enviarUno()) {
                espera = Math.ceil(60000 / porMinuto());
            }
        }
    } catch (e) {
        console.error('❌ Cola de correos:', e.message);
    }
    setTimeout(ciclo, Math.max(espera, 1000));
}

/** Arranca el trabajador (una vez, al conectar a Mongo). */
async function iniciar() {
    if (estado.corriendo) return;
    estado.corriendo = true;
    // Lo que quedó "enviando" por un reinicio vuelve a la fila.
    await EnvioCorreo.updateMany({ estado: 'enviando', tomadoAt: { $lt: new Date(Date.now() - 5 * 60000) } }, { $set: { estado: 'pendiente' } }).catch(() => {});
    setTimeout(ciclo, 15000);
    console.log(`📮 Cola de correos: ${conProveedorMasivo() ? process.env.MASIVO_SMTP_HOST : 'cuenta de siempre (EMAIL_*)'}, ${porMinuto()}/min, ${limiteDia()}/día`);
}

/**
 * Crea un lote y sus destinatarios ([{ to, nombre, encuestaId }]). Repetidos y
 * correos de baja se omiten. Devuelve el lote.
 */
async function encolar({ tipo, asunto, html, text, descripcion, creadoPor, destinatarios }) {
    const bajas = await correosDeBaja();
    const vistos = new Set();
    const lista = [];
    for (const d of destinatarios) {
        const to = String(d.to || '').trim().toLowerCase();
        if (!to || vistos.has(to) || bajas.has(to)) continue;
        vistos.add(to);
        lista.push({ ...d, to });
    }
    const lote = await LoteCorreo.create({ tipo, asunto, html, text, descripcion, creadoPor, total: lista.length });
    if (lista.length) {
        await EnvioCorreo.insertMany(lista.map((d) => ({ lote: lote._id, tipo, to: d.to, nombre: d.nombre, encuestaId: d.encuestaId })), { ordered: false })
            .catch((e) => { if (e.code !== 11000) throw e; });
    }
    return lote;
}

/** Avance del último lote de un tipo, para el panel. */
async function avance(tipo) {
    const lote = await LoteCorreo.findOne({ tipo }).sort({ createdAt: -1 }).lean();
    if (!lote) return null;
    const cuenta = await EnvioCorreo.aggregate([{ $match: { lote: lote._id } }, { $group: { _id: '$estado', n: { $sum: 1 } } }]);
    const n = Object.fromEntries(cuenta.map((c) => [c._id, c.n]));
    const pendientes = (n.pendiente || 0) + (n.enviando || 0);
    const hoy = await enviadosHoy();
    return {
        asunto: lote.asunto, descripcion: lote.descripcion, at: lote.createdAt,
        total: lote.total, enviados: n.enviado || 0, errores: n.error || 0, pendientes,
        terminado: pendientes === 0,
        pausa: estado.pausaHasta && estado.pausaHasta > new Date() ? { hasta: estado.pausaHasta, motivo: estado.motivo } : null,
        ritmo: { porMinuto: porMinuto(), limiteDia: limiteDia(), enviadosHoy: hoy, proveedor: conProveedorMasivo() ? 'masivo' : 'GoDaddy' },
    };
}

/** ¿Hay algo pendiente de este tipo? (para no encimar dos envíos) */
const hayPendientes = async (tipo) => Boolean(await EnvioCorreo.exists({ tipo, estado: { $in: ['pendiente', 'enviando'] } }));

/** Un correo suelto por el proveedor masivo (la prueba del correo de la semana). */
async function enviarDirecto({ to, subject, html, text, headers }) {
    try {
        await transport().sendMail({ from: remitente(), to, subject, html, text, headers });
        return true;
    } catch (e) {
        console.error('❌ Correo de prueba:', String(e.response || e.message).slice(0, 200));
        return false;
    }
}

module.exports = { registrar, iniciar, encolar, avance, hayPendientes, enviarDirecto };
