/**
 * Correos de la semana. Dos plantillas con el mismo armado:
 *   - Despensas (lunes): imagen de promociones + las despensas del catálogo
 *     (foto, precio, qué incluyen y botón para pedir).
 *   - Promos (miércoles/jueves): recordatorio con las imágenes de promociones,
 *     la hora de cierre y botones para pedir por WhatsApp, en línea o Telegram.
 * Se puede mandar a todos o solo a quien todavía no tiene pedido esta semana.
 *
 * Los enlaces llevan utm_source=email: la tienda guarda el pedido con
 * fuente 'email', así en Métricas se ve cuánto vende cada correo.
 */
const Despensas = require('../models/Despensas');
require('../models/Product');   // para el populate de los productos
const Clientes = require('../models/Clientes');
const Pedido = require('../models/Pedidos');
const { fechaAISO, hoyMX, sumarDias } = require('./encuestas');
const EmailCampaign = require('../models/EmailCampaign');
const bajas = require('./bajasCorreo');
const cola = require('./colaCorreo');

const TIENDA = 'https://www.freshmarket.mx/';
const LOGO = 'https://www.freshmarket.mx/logo.png';
const WHATSAPP = 'https://wa.me/527712346620';
// Shade ve de dónde viene el pedido; Telegram registra el origen "correo".
const WHATSAPP_PEDIDO = `${WHATSAPP}?text=${encodeURIComponent('Hola, quiero hacer mi pedido (vi las promos del correo) 🥕')}`;
const TELEGRAM = 'https://t.me/FreshPachucaBot?start=correo';
const PUEBLOS = /tizayuca|acayuca|zapotlan|tolcayuca|metztitl|real del monte|mineral del monte/;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sinAcentos = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
const primerNombre = (n) => {
    const p = String(n || '').split('-')[0].trim().split(/\s+/)[0] || '';
    return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : '';
};
const dinero = (n) => `$${Number(n || 0).toLocaleString('es-MX')}`;

/** Despensas visibles en la tienda, de la más barata a la más cara. */
async function despensasDelCatalogo() {
    const ds = await Despensas.find({ showInWeb: true, name: { $nin: ['Pedido', 'REPOSICION'] }, price: { $gt: 0 } })
        .populate('products.productId', 'title nombreSinUnidades')
        .sort({ price: 1 })
        .lean();
    return ds.map((d) => {
        const nombres = d.products.map((p) => p.productId && (p.productId.nombreSinUnidades || p.productId.title)).filter(Boolean);
        return { nombre: d.name, precio: d.price, img: d.img, total: nombres.length, nombres };
    });
}

function enlace(campana) {
    return `${TIENDA}?utm_source=email&utm_medium=correo&utm_campaign=${encodeURIComponent(campana)}`;
}

function tarjetaDespensa(d, url) {
    const muestra = d.nombres.slice(0, 7).join(', ') + (d.total > 7 ? ` y ${d.total - 7} más` : '');
    return `
    <td width="50%" valign="top" style="padding:8px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff; border:1px solid #e5e7eb; border-radius:12px; overflow:hidden;">
        <tr><td><a href="${url}"><img src="${esc(d.img)}" alt="Despensa ${esc(d.nombre)}" width="100%" style="display:block; width:100%; height:auto; border:0;"></a></td></tr>
        <tr><td style="padding:12px 12px 4px; font-family:Arial,sans-serif;">
          <div style="font-size:17px; font-weight:bold; color:#111827;">Despensa ${esc(d.nombre)}</div>
          <div style="font-size:22px; font-weight:bold; color:#15803d; margin-top:2px;">${dinero(d.precio)}</div>
          <div style="font-size:12px; color:#6b7280; margin-top:6px; line-height:1.4;">${d.total} productos: ${esc(muestra)}</div>
        </td></tr>
        <tr><td style="padding:10px 12px 14px;">
          <a href="${url}" style="display:block; text-align:center; background:#15803d; color:#ffffff; padding:10px; border-radius:999px; text-decoration:none; font-weight:bold; font-family:Arial,sans-serif; font-size:14px;">Pedir</a>
        </td></tr>
      </table>
    </td>`;
}

const boton = (href, txt, color) => `<tr><td style="padding:6px 0;"><a href="${href}" style="display:block; text-align:center; background:${color}; color:#ffffff; padding:15px 20px; border-radius:999px; text-decoration:none; font-weight:bold; font-family:Arial,sans-serif; font-size:17px;">${txt}</a></td></tr>`;

/**
 * HTML del correo. `{{nombre}}` y `{{baja}}` quedan para personalizar por cliente.
 * opciones: { intro, imagenes, aviso, botones: {tienda, whatsapp, telegram}, conDespensas, campana, despensas }
 */
function armarHtml({ intro, imagenes = [], aviso, botones = {}, conDespensas, campana, despensas }) {
    const url = enlace(campana);
    const introHtml = esc(intro || '').replace(/\n/g, '<br>');
    let gridDespensas = '';
    if (conDespensas && despensas.length) {
        const filas = [];
        for (let i = 0; i < despensas.length; i += 2) {
            filas.push(`<tr>${tarjetaDespensa(despensas[i], url)}${despensas[i + 1] ? tarjetaDespensa(despensas[i + 1], url) : '<td width="50%"></td>'}</tr>`);
        }
        gridDespensas = `
        <tr><td style="padding:22px 16px 4px; font-family:Arial,sans-serif;">
          <div style="font-size:20px; font-weight:bold; color:#111827;">🧺 Despensas de la semana</div>
          <div style="font-size:14px; color:#6b7280; margin-top:4px;">Frutas, verduras y carnes frescas hasta tu puerta.</div>
        </td></tr>
        <tr><td style="padding:4px 8px;"><table width="100%" cellpadding="0" cellspacing="0">${filas.join('')}</table></td></tr>`;
    }
    const fotos = imagenes.map((img) => `<tr><td style="padding:14px 16px 4px;"><a href="${url}"><img src="${esc(img)}" alt="Promociones de la semana" width="100%" style="display:block; width:100%; height:auto; border:0; border-radius:12px;"></a></td></tr>`).join('');
    const hayBotones = botones.tienda || botones.whatsapp || botones.telegram;
    const pedir = hayBotones
        ? `<table width="100%" cellpadding="0" cellspacing="0">
            ${botones.whatsapp ? boton(WHATSAPP_PEDIDO, '💬 Pedir por WhatsApp', '#1f9d55') : ''}
            ${botones.tienda ? boton(url, '🛒 Pedir en línea', '#15803d') : ''}
            ${botones.telegram ? boton(TELEGRAM, '✈️ Pedir por Telegram', '#229ED9') : ''}
           </table>`
        : `<a href="${url}" style="display:inline-block; background:#15803d; color:#ffffff; padding:15px 32px; border-radius:999px; text-decoration:none; font-weight:bold; font-family:Arial,sans-serif; font-size:17px;">Hacer mi pedido 🥕</a>
           <div style="font-family:Arial,sans-serif; font-size:14px; color:#4b5563; margin-top:14px;">o pide por WhatsApp: <a href="${WHATSAPP}" style="color:#15803d; font-weight:bold;">771 234 6620</a></div>`;
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0; padding:0; background:#f4f4f0;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f0; padding:16px 0;"><tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px; background:#fafaf7; border-radius:14px; overflow:hidden;">
    <tr><td style="background:#15803d; padding:16px; text-align:center;">
      <img src="${LOGO}" alt="Fresh Market" height="44" style="height:44px; background:#ffffff; border-radius:8px; padding:4px;">
    </td></tr>
    <tr><td style="padding:22px 20px 6px; font-family:Arial,sans-serif; color:#111827;">
      <div style="font-size:18px; font-weight:bold;">Hola {{nombre}} 👋</div>
      ${introHtml ? `<div style="font-size:15px; line-height:1.55; margin-top:8px; color:#374151;">${introHtml}</div>` : ''}
    </td></tr>
    ${fotos}
    ${gridDespensas}
    <tr><td style="padding:22px 20px; text-align:center;">
      ${aviso ? `<div style="background:#fff7ed; border:1px solid #fed7aa; color:#9a3412; border-radius:12px; padding:12px; font-family:Arial,sans-serif; font-size:16px; font-weight:bold; margin-bottom:14px;">${esc(aviso)}</div>` : ''}
      ${pedir}
    </td></tr>
    <tr><td style="background:#1f2937; padding:14px; text-align:center; color:#9ca3af; font-family:Arial,sans-serif; font-size:11px;">
      Fresh Market Pachuca · ¿Ya no quieres recibir estos correos? <a href="{{baja}}" style="color:#9ca3af; text-decoration:underline;">Darme de baja</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function texto({ intro, aviso, botones = {}, campana }) {
    const lineas = [`Hola {{nombre}},`, '', intro || 'Ya están las despensas y promociones de esta semana.', ''];
    if (aviso) lineas.push(aviso, '');
    lineas.push(`Pide en línea: ${enlace(campana)}`, `Por WhatsApp: ${botones.whatsapp ? WHATSAPP_PEDIDO : '771 234 6620'}`);
    if (botones.telegram) lineas.push(`Por Telegram: ${TELEGRAM}`);
    lineas.push('', 'Fresh Market', 'Para ya no recibir estos correos: {{baja}}');
    return lineas.join('\n');
}

const personalizar = (s, nombre, email) => s.replace(/{{nombre}}/g, esc(nombre) || '').replace(/{{baja}}/g, email ? bajas.urlBaja(email) : '#');
/** Encabezados para el botón de baja de Gmail/Outlook (un clic, RFC 8058). */
const encabezadosBaja = (email) => ({ 'List-Unsubscribe': `<${bajas.urlBaja(email)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });

/** Teléfonos (10 dígitos) con pedido para esta semana (entrega desde el lunes). */
async function telefonosConPedidoEstaSemana() {
    const hoy = hoyMX();
    const dia = new Date(`${hoy}T12:00:00Z`).getUTCDay();          // 0 = domingo
    const lunes = sumarDias(hoy, -((dia + 6) % 7));
    const ps = await Pedido.find({ createdAt: { $gte: new Date(Date.now() - 14 * 864e5) } }, { telefono: 1, fecha: 1 }).lean();
    const tels = new Set();
    for (const p of ps) {
        const iso = fechaAISO(p.fecha);
        const t = String(p.telefono || '').replace(/\D/g, '').slice(-10);
        if (iso && iso >= lunes && t.length === 10) tels.add(t);
    }
    return tels;
}

/** Clientes con correo válido (sin repetir correos). Con soloSinPedido, sin los que ya pidieron esta semana. */
async function destinatarios({ excluirPueblos, soloSinPedido }) {
    const cs = await Clientes.find({ email: { $nin: [null, ''] } }, { nombre: 1, email: 1, direccion: 1, telefono: 1 }).lean();
    const vistos = await bajas.correosDeBaja();   // los de baja cuentan como ya vistos: no se les manda
    const conPedido = soloSinPedido ? await telefonosConPedidoEstaSemana() : null;
    const lista = [];
    for (const c of cs) {
        const email = String(c.email).trim().toLowerCase();
        if (!emailValido(email) || vistos.has(email)) continue;
        if (excluirPueblos && PUEBLOS.test(sinAcentos(`${c.nombre} ${c.direccion}`))) continue;
        if (conPedido && conPedido.has(String(c.telefono || '').replace(/\D/g, '').slice(-10))) continue;
        vistos.add(email);
        lista.push({ email, nombre: primerNombre(c.nombre) });
    }
    return lista;
}

// Cómo se arma el correo de la semana para cada destinatario al mandarlo.
cola.registrar('semanal', async (envio, lote) => ({
    subject: personalizar(lote.asunto, envio.nombre),
    html: personalizar(lote.html, envio.nombre, envio.to),
    text: personalizar(lote.text, envio.nombre, envio.to),
    headers: encabezadosBaja(envio.to),
}));

async function armar(d) {
    const despensas = d.conDespensas ? await despensasDelCatalogo() : [];
    return { despensas, html: armarHtml({ ...d, despensas }), txt: texto(d) };
}

async function enviar({ soloA, creadoPor, ...d }) {
    const { html, txt } = await armar(d);
    if (soloA) {   // prueba: sale por el mismo proveedor que el envío masivo
        return cola.enviarDirecto({ to: soloA, subject: `[PRUEBA] ${d.asunto}`, html: personalizar(html, 'María', soloA), text: personalizar(txt, 'María', soloA) });
    }
    if (await cola.hayPendientes('semanal')) throw new Error('Todavía se está mandando el correo anterior');
    const lista = await destinatarios(d);
    const lote = await cola.encolar({
        tipo: 'semanal', asunto: d.asunto, html, text: txt, creadoPor,
        descripcion: `${d.asunto} (${d.campana}${d.soloSinPedido ? ', solo sin pedido' : ''})`,
        destinatarios: lista.map((x) => ({ to: x.email, nombre: x.nombre })),
    });
    await EmailCampaign.create({ subject: d.asunto, body: d.intro || '(correo de la semana)', target: d.soloSinPedido ? 'semanal-sin-pedido' : 'semanal', recipientCount: lote.total, status: 'cola' }).catch(() => {});
    return { total: lote.total };
}

async function vistaPrevia(d) {
    const { html, despensas } = await armar(d);
    const [todos, sinPedido] = await Promise.all([
        destinatarios({ ...d, soloSinPedido: false }),
        destinatarios({ ...d, soloSinPedido: true }),
    ]);
    return {
        html: personalizar(html, 'María'),
        destinatarios: todos.length,
        sinPedido: sinPedido.length,
        despensas: despensas.map((x) => `${x.nombre} ${dinero(x.precio)}`),
    };
}

module.exports = { enviar, vistaPrevia, estado: () => cola.avance('semanal') };
