/**
 * Correo de la semana: la imagen de promociones + las despensas del catálogo
 * (foto, precio, qué incluyen y botón para pedir).
 *
 * Los enlaces llevan utm_source=email: la tienda guarda el pedido con
 * fuente 'email', así en Métricas se ve cuánto vende cada correo.
 */
const Despensas = require('../models/Despensas');
require('../models/Product');   // para el populate de los productos
const Clientes = require('../models/Clientes');
const EmailCampaign = require('../models/EmailCampaign');
const bajas = require('./bajasCorreo');
const cola = require('./colaCorreo');

const TIENDA = 'https://www.freshmarket.mx/';
const LOGO = 'https://www.freshmarket.mx/logo.png';
const WHATSAPP = 'https://wa.me/527712346620';
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

/**
 * HTML del correo. `{{nombre}}` queda para personalizar por cliente.
 * opciones: { intro, promoImg, conDespensas, campana, despensas }
 */
function armarHtml({ intro, promoImg, conDespensas, campana, despensas }) {
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
    ${promoImg ? `<tr><td style="padding:14px 16px 4px;"><a href="${url}"><img src="${esc(promoImg)}" alt="Promociones de la semana" width="100%" style="display:block; width:100%; height:auto; border:0; border-radius:12px;"></a></td></tr>` : ''}
    ${gridDespensas}
    <tr><td style="padding:22px 20px; text-align:center;">
      <a href="${url}" style="display:inline-block; background:#15803d; color:#ffffff; padding:15px 32px; border-radius:999px; text-decoration:none; font-weight:bold; font-family:Arial,sans-serif; font-size:17px;">Hacer mi pedido 🥕</a>
      <div style="font-family:Arial,sans-serif; font-size:14px; color:#4b5563; margin-top:14px;">o pide por WhatsApp: <a href="${WHATSAPP}" style="color:#15803d; font-weight:bold;">771 234 6620</a></div>
    </td></tr>
    <tr><td style="background:#1f2937; padding:14px; text-align:center; color:#9ca3af; font-family:Arial,sans-serif; font-size:11px;">
      Fresh Market Pachuca · ¿Ya no quieres recibir estos correos? <a href="{{baja}}" style="color:#9ca3af; text-decoration:underline;">Darme de baja</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function texto({ intro, campana }) {
    return `Hola {{nombre}},\n\n${intro || 'Ya están las despensas y promociones de esta semana.'}\n\nHaz tu pedido: ${enlace(campana)}\nO por WhatsApp: 771 234 6620\n\nFresh Market\nPara ya no recibir estos correos: {{baja}}`;
}

const personalizar = (s, nombre, email) => s.replace(/{{nombre}}/g, esc(nombre) || '').replace(/{{baja}}/g, email ? bajas.urlBaja(email) : '#');
/** Encabezados para el botón de baja de Gmail/Outlook (un clic, RFC 8058). */
const encabezadosBaja = (email) => ({ 'List-Unsubscribe': `<${bajas.urlBaja(email)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });

/** Clientes con correo válido (sin repetir correos). */
async function destinatarios({ excluirPueblos }) {
    const cs = await Clientes.find({ email: { $nin: [null, ''] } }, { nombre: 1, email: 1, direccion: 1 }).lean();
    const vistos = await bajas.correosDeBaja();   // los de baja cuentan como ya vistos: no se les manda
    const lista = [];
    for (const c of cs) {
        const email = String(c.email).trim().toLowerCase();
        if (!emailValido(email) || vistos.has(email)) continue;
        if (excluirPueblos && PUEBLOS.test(sinAcentos(`${c.nombre} ${c.direccion}`))) continue;
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

async function enviar({ asunto, intro, promoImg, conDespensas, excluirPueblos, campana, soloA, creadoPor }) {
    const despensas = conDespensas ? await despensasDelCatalogo() : [];
    const html = armarHtml({ intro, promoImg, conDespensas, campana, despensas });
    const txt = texto({ intro, campana });

    if (soloA) {   // prueba: sale por el mismo proveedor que el envío masivo
        return cola.enviarDirecto({ to: soloA, subject: `[PRUEBA] ${asunto}`, html: personalizar(html, 'María', soloA), text: personalizar(txt, 'María', soloA) });
    }
    if (await cola.hayPendientes('semanal')) throw new Error('Todavía se está mandando el correo anterior');
    const lista = await destinatarios({ excluirPueblos });
    const lote = await cola.encolar({
        tipo: 'semanal', asunto, html, text: txt, creadoPor,
        descripcion: `Correo de la semana (${campana})`,
        destinatarios: lista.map((d) => ({ to: d.email, nombre: d.nombre })),
    });
    await EmailCampaign.create({ subject: asunto, body: intro || '(correo de la semana)', target: 'semanal', recipientCount: lote.total, status: 'cola' }).catch(() => {});
    return { total: lote.total };
}

async function vistaPrevia({ intro, promoImg, conDespensas, excluirPueblos, campana }) {
    const despensas = conDespensas ? await despensasDelCatalogo() : [];
    const html = personalizar(armarHtml({ intro, promoImg, conDespensas, campana, despensas }), 'María');
    const lista = await destinatarios({ excluirPueblos });
    return { html, destinatarios: lista.length, despensas: despensas.map((d) => `${d.nombre} ${dinero(d.precio)}`) };
}

module.exports = { enviar, vistaPrevia, estado: () => cola.avance('semanal') };
