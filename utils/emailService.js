const nodemailer = require('nodemailer');
const path = require('path');

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: true,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    logger: false, // Menos ruido en consola
    debug: false
});

// 🧠 CEREBRO INTELIGENTE: Reemplaza variables en el texto
// Ej: "Hola {{nombre}}, tienes {{puntos}} puntos. Te faltan {{20-sellos}} para el premio."
const procesarTextoDinamico = (texto, cliente) => {
    if (!texto) return '';

    return texto.replace(/{{(.*?)}}/g, (match, contenido) => {
        const key = contenido.trim(); // Quita espacios

        // 1. Variables Directas
        if (key === 'nombre') return cliente.nombre ? cliente.nombre.split(' ')[0] : 'Cliente';
        if (key === 'nombre_completo') return cliente.nombre || 'Cliente';
        if (key === 'puntos') return cliente.puntos || 0;
        if (key === 'sellos') return cliente.sellos || 0;

        // 2. Fórmulas Matemáticas Simples (Ej: 14-puntos)
        if (key.includes('-')) {
            const partes = key.split('-');
            const meta = parseInt(partes[0]);
            const variable = partes[1]; // 'puntos' o 'sellos'

            const valorActual = cliente[variable] || 0;
            const restante = meta - valorActual;
            return restante > 0 ? restante : 0;
        }

        return match; // Si no reconoce la variable, la deja igual
    });
};

// --- FUNCIÓN DE BIENVENIDA (LA DEJAMOS IGUAL, FUNCIONA BIEN) ---
// utils/emailService.js

// ... (tus imports y transporter arriba siguen igual) ...

const sendWelcomeEmail = async (email, nombre, clienteId) => {
    try {
        const appleLink = `https://backendfresh-production.up.railway.app/api/wallet/download/apple/${clienteId}`;
        const googleLink = `https://backendfresh-production.up.railway.app/api/wallet/download/google/${clienteId}`;

        const nombreLimpio = String(nombre || 'Cliente').split('-')[0].trim();

        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 20px;">
            <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 10px; overflow: hidden;">
                <div style="background-color: #15803d; padding: 20px; text-align: center; color: white;">
                    <h1>¡Bienvenido a Fresh Market! 🥕</h1>
                </div>
                <div style="padding: 20px; color: #333;">
                    <p style="font-size: 18px;">Hola <strong>${nombreLimpio}</strong>,</p>
                    <p>Tu cuenta ha sido activada correctamente. Ahora eres parte de nuestra comunidad.</p>
                    
                    <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; padding: 15px; border-radius: 8px; margin: 20px 0;">
                        <h3 style="margin-top: 0; color: #166534;">🎁 Descarga tu Tarjeta Digital</h3>
                        <p style="font-size: 14px;">Acumula puntos, sellos y gana premios en cada compra.</p>
                        
                        <div style="text-align: center; margin-top: 15px;">
                            <a href="${appleLink}" style="display: inline-block; background-color: #000; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin: 5px;">
                                 Apple Wallet
                            </a>
                            <a href="${googleLink}" style="display: inline-block; background-color: #3b82f6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin: 5px;">
                                🤖 Google Wallet
                            </a>
                        </div>
                    </div>

                    <p>Esperamos tu primer pedido pronto.</p>
                </div>
            </div>
        </body>
        </html>
        `;

        await transporter.sendMail({
            from: '"Fresh Market" <pedidos@freshmarket.mx>',
            to: email,
            subject: 'Bienvenido a Fresh Market - Descarga tu Wallet (si aún no lo has hecho) 📱',
            html: htmlContent
        });

        console.log(`✅ Correo de bienvenida enviado a ${email}`);
        return true;
    } catch (error) {
        console.error("Error enviando bienvenida:", error);
        return false;
    }
};

// ... (el resto de tu archivo con sendSmartEmail sigue igual) ...


// --- 🔥 LA NUEVA JOYA: SEND SMART EMAIL ---
const sendSmartEmail = async (clienteData, asunto, mensajeBase, opciones = {}) => {
    // clienteData debe tener: { email, nombre, puntos, sellos, _id }
    // opciones: { bannerUrl, ctaText, ctaLink, resources: [{label, url, type}] }

    try {
        const { email, nombre } = clienteData;

        // 1. PROCESAR EL MENSAJE (PERSONALIZACIÓN)
        // Aquí ocurre la magia de "Te faltan 3 puntos"
        const mensajePersonalizado = procesarTextoDinamico(mensajeBase, clienteData);
        const mensajeHTML = mensajePersonalizado.replace(/\n/g, '<br />'); // Saltos de línea

        // 2. CONSTRUCCIÓN DE BLOQUES HTML

        // A. Banner Principal
        const bannerBlock = opciones.bannerUrl
            ? `<div style="margin-bottom: 25px; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                 <img src="${opciones.bannerUrl}" style="width: 100%; max-width: 600px; height: auto; display: block;" alt="Promo" />
               </div>`
            : '';

        // B. Botón Principal (CTA)
        const botonBlock = opciones.ctaLink
            ? `<div style="text-align: center; margin: 30px 0;">
                 <a href="${opciones.ctaLink}" style="display: inline-block; background-color: #15803d; color: white; padding: 14px 28px; text-decoration: none; border-radius: 50px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 10px rgba(21, 128, 61, 0.3);">
                    ${opciones.ctaText || 'Ver Más 🥕'}
                 </a>
               </div>`
            : '';

        // C. Sección de Recursos (PDFs, Links Extra)
        // Espera un array: opciones.resources = [{ label: 'Descargar Menú PDF', url: '...', type: 'pdf' }]
        let recursosBlock = '';
        if (opciones.resources && opciones.resources.length > 0) {
            const items = opciones.resources.map(res => `
                <a href="${res.url}" style="display: block; background: #f8fafc; border: 1px solid #e2e8f0; padding: 12px 15px; margin-bottom: 8px; border-radius: 8px; text-decoration: none; color: #334155; display: flex; align-items: center;">
                    <span style="background: #e0f2fe; color: #0284c7; padding: 4px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; margin-right: 10px; text-transform: uppercase;">${res.type || 'LINK'}</span>
                    <span style="font-weight: 500;">${res.label}</span>
                    <span style="margin-left: auto; color: #94a3b8;">⬇</span>
                </a>
            `).join('');

            recursosBlock = `
                <div style="margin-top: 30px; border-top: 1px dashed #cbd5e1; padding-top: 20px;">
                    <p style="font-size: 12px; font-weight: bold; color: #64748b; text-transform: uppercase; margin-bottom: 10px; letter-spacing: 1px;">Material Adicional</p>
                    ${items}
                </div>
            `;
        }

        // 3. PLANTILLA MAESTRA (DISEÑO PROFESIONAL)
        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: 'Helvetica Neue', Arial, sans-serif;">
            
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                    <td style="padding: 20px 0; text-align: center;">
                        <table role="presentation" width="100%" style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);" cellspacing="0" cellpadding="0" border="0">
                            
                            <tr>
                                <td style="background-color: #15803d; padding: 20px; text-align: center;">
                                    <img src="cid:logoFresh" alt="Fresh Market" style="width: 100px; height: auto; display: block; margin: 0 auto;" />
                                </td>
                            </tr>

                            <tr>
                                <td style="padding: 30px;">
                                    
                                    ${bannerBlock}

                                    <h2 style="color: #111827; margin: 0 0 15px 0; font-size: 20px;">Hola, ${procesarTextoDinamico('{{nombre}}', clienteData)} 👋</h2>
                                    
                                    <div style="font-size: 16px; line-height: 1.6; color: #4b5563;">
                                        ${mensajeHTML}
                                    </div>

                                    ${botonBlock}
                                    
                                    ${recursosBlock}

                                </td>
                            </tr>

                            <tr>
                                <td style="background-color: #f0fdf4; padding: 20px; text-align: center; border-top: 1px solid #dcfce7;">
                                    <p style="margin: 0 0 10px 0; font-size: 14px; color: #166534; font-weight: 500;">¿Tienes dudas o quieres hacer tu pedido?</p>
                                    <a href="https://wa.me/527712346620" style="display: inline-flex; align-items: center; justify-content: center; background-color: #25D366; color: white; padding: 8px 16px; border-radius: 20px; text-decoration: none; font-size: 13px; font-weight: bold;">
                                        <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/WhatsApp.svg/120px-WhatsApp.svg.png" width="16" height="16" style="margin-right: 5px;" alt="WA"/>
                                        Escríbenos al WhatsApp
                                    </a>
                                </td>
                            </tr>

                            <tr>
                                <td style="background-color: #1f2937; padding: 20px; text-align: center; color: #9ca3af; font-size: 11px;">
                                    <p style="margin: 5px 0;">Fresh Market Pachuca</p>
                                    <p style="margin: 5px 0;">Frescura en cada producto🥕</p>
                                    <p style="margin: 15px 0 0 0;"><a href="#" style="color: #6b7280; text-decoration: underline;">Darse de baja</a></p>
                                </td>
                            </tr>

                        </table>
                    </td>
                </tr>
            </table>

        </body>
        </html>
        `;

        await transporter.sendMail({
            from: '"Fresh Market" <pedidos@freshmarket.mx>',
            to: email,
            subject: procesarTextoDinamico(asunto, clienteData), // También personalizamos el asunto
            text: mensajePersonalizado,
            html: htmlContent,
            attachments: [
                {
                    filename: 'logo.png',
                    path: path.join(__dirname, '../assets/freshmarket/logo.png'),
                    cid: 'logoFresh'
                }
            ]
        });

        return true;
    } catch (error) {
        console.error(`❌ Error enviando a ${clienteData.email}:`, error.message);
        return false;
    }
};

// --- RECUPERACIÓN DE PIN ---
const sendPinRecoveryEmail = async (email, nombre, codigo) => {
    try {
        const nombreLimpio = String(nombre || 'Cliente').split('-')[0].split(' ')[0].trim();

        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: 'Helvetica Neue', Arial, sans-serif;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                    <td style="padding: 20px 0; text-align: center;">
                        <table role="presentation" width="100%" style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1);" cellspacing="0" cellpadding="0" border="0">
                            <tr>
                                <td style="background-color: #15803d; padding: 24px; text-align: center; color: white;">
                                    <h1 style="margin: 0; font-size: 22px;">🔑 Recupera tu PIN</h1>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding: 32px;">
                                    <p style="font-size: 16px; color: #111827; margin: 0 0 12px 0;">Hola <strong>${nombreLimpio}</strong>,</p>
                                    <p style="font-size: 15px; color: #4b5563; line-height: 1.6; margin: 0 0 24px 0;">
                                        Recibimos una solicitud para restablecer el PIN de tu cuenta de Fresh Market. Usa el siguiente código para crear un PIN nuevo:
                                    </p>
                                    <div style="text-align: center; margin: 28px 0;">
                                        <div style="display: inline-block; background: #f0fdf4; border: 2px dashed #16a34a; padding: 18px 32px; border-radius: 12px;">
                                            <p style="margin: 0 0 6px 0; font-size: 11px; color: #166534; letter-spacing: 2px; font-weight: bold;">TU CÓDIGO</p>
                                            <p style="margin: 0; font-size: 36px; font-weight: 800; color: #166534; letter-spacing: 8px; font-family: 'Courier New', monospace;">${codigo}</p>
                                        </div>
                                    </div>
                                    <p style="font-size: 13px; color: #6b7280; line-height: 1.6; margin: 0 0 8px 0;">
                                        ⏱️ Este código es válido por <strong>15 minutos</strong>.
                                    </p>
                                    <p style="font-size: 13px; color: #6b7280; line-height: 1.6; margin: 0;">
                                        Si tú no solicitaste este cambio, puedes ignorar este correo. Tu PIN actual seguirá funcionando.
                                    </p>
                                </td>
                            </tr>
                            <tr>
                                <td style="background-color: #f0fdf4; padding: 16px; text-align: center; border-top: 1px solid #dcfce7;">
                                    <p style="margin: 0 0 8px 0; font-size: 13px; color: #166534;">¿Necesitas ayuda?</p>
                                    <a href="https://wa.me/527712346620" style="display: inline-block; background-color: #25D366; color: white; padding: 8px 16px; border-radius: 20px; text-decoration: none; font-size: 13px; font-weight: bold;">
                                        Escríbenos al WhatsApp
                                    </a>
                                </td>
                            </tr>
                            <tr>
                                <td style="background-color: #1f2937; padding: 16px; text-align: center; color: #9ca3af; font-size: 11px;">
                                    <p style="margin: 4px 0;">Fresh Market Pachuca</p>
                                    <p style="margin: 4px 0;">Frescura en cada producto 🥕</p>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </body>
        </html>
        `;

        const textContent = `Hola ${nombreLimpio},\n\nTu código para restablecer el PIN de Fresh Market es: ${codigo}\n\nEs válido por 15 minutos. Si no solicitaste este cambio, ignora este correo.\n\nFresh Market`;

        await transporter.sendMail({
            from: '"Fresh Market" <pedidos@freshmarket.mx>',
            to: email,
            subject: `Tu código de recuperación: ${codigo}`,
            text: textContent,
            html: htmlContent
        });

        console.log(`✅ Correo de recuperación enviado a ${email}`);
        return true;
    } catch (error) {
        console.error("Error enviando correo de recuperación:", error);
        return false;
    }
};

// --- CONFIRMACIÓN DE PEDIDO ---
// Envía UN solo correo por orden (aunque la orden tenga varias despensas).
// - Al cliente si tiene email (to) + copia al negocio (bcc pedidos@freshmarket.mx).
// - Si el cliente no tiene email, solo la copia al negocio (to pedidos@freshmarket.mx).
const CORREO_NEGOCIO = 'pedidos@freshmarket.mx';

const formatMoneyMX = (n) =>
    '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

// Quita el sufijo " $123" que a veces trae el title de newProducts
const limpiaTitulo = (t) => String(t || '').split(' $')[0].trim();

const sendOrderConfirmationEmail = async ({ email, nombre, refId, fecha, total, pedidos = [] }) => {
    try {
        const nombreLimpio = String(nombre || 'Cliente').split('-')[0].split(' ')[0].trim();

        // Bloque HTML por cada pedido (despensa o "Pedido" de productos sueltos)
        const pedidosBlock = pedidos.map(p => {
            const eliminados = (p.deletedProducts || [])
                .map(d => `<li style="color:#9ca3af; text-decoration:line-through; margin:2px 0;">${d.nombre || ''}</li>`)
                .join('');
            const agregados = (p.newProducts || [])
                .map(n => `<li style="margin:2px 0;">${limpiaTitulo(n.title)}</li>`)
                .join('');

            return `
                <div style="border:1px solid #e5e7eb; border-radius:12px; padding:16px; margin-bottom:12px;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <strong style="color:#111827; font-size:16px;">${p.despensa || 'Pedido'}</strong>
                        <span style="color:#15803d; font-weight:bold;">${formatMoneyMX(p.total)}</span>
                    </div>
                    ${agregados ? `<ul style="margin:10px 0 0 0; padding-left:18px; font-size:14px; color:#4b5563;">${agregados}</ul>` : ''}
                    ${eliminados ? `<p style="margin:10px 0 4px 0; font-size:12px; color:#9ca3af;">Quitado:</p><ul style="margin:0; padding-left:18px; font-size:13px;">${eliminados}</ul>` : ''}
                </div>`;
        }).join('');

        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin:0; padding:0; background-color:#f3f4f6; font-family:'Helvetica Neue', Arial, sans-serif;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                    <td style="padding:20px 0; text-align:center;">
                        <table role="presentation" width="100%" style="max-width:600px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 10px 15px -3px rgba(0,0,0,0.1);" cellspacing="0" cellpadding="0" border="0">
                            <tr>
                                <td style="background-color:#15803d; padding:20px; text-align:center;">
                                    <img src="cid:logoFresh" alt="Fresh Market" style="width:100px; height:auto; display:block; margin:0 auto;" />
                                </td>
                            </tr>
                            <tr>
                                <td style="padding:30px;">
                                    <h2 style="color:#111827; margin:0 0 6px 0; font-size:22px;">¡Gracias por tu pedido, ${nombreLimpio}! 🥕</h2>
                                    <p style="font-size:15px; color:#4b5563; margin:0 0 20px 0;">Ya recibimos tu pedido. Aquí están los detalles:</p>

                                    <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; padding:14px 18px; margin-bottom:20px;">
                                        <p style="margin:0 0 4px 0; font-size:13px; color:#166534;">Código de pedido</p>
                                        <p style="margin:0 0 10px 0; font-size:24px; font-weight:800; color:#166534; letter-spacing:2px;">${refId || '—'}</p>
                                        <p style="margin:0; font-size:14px; color:#166534;">📅 Entrega: <strong>${fecha || 'Por confirmar'}</strong></p>
                                    </div>

                                    ${pedidosBlock}

                                    <div style="border-top:2px solid #111827; margin-top:8px; padding-top:14px; text-align:right;">
                                        <span style="font-size:18px; color:#111827;">Total: <strong style="color:#15803d;">${formatMoneyMX(total)}</strong></span>
                                    </div>
                                </td>
                            </tr>
                            <tr>
                                <td style="background-color:#f0fdf4; padding:20px; text-align:center; border-top:1px solid #dcfce7;">
                                    <p style="margin:0 0 10px 0; font-size:14px; color:#166534; font-weight:500;">¿Alguna duda con tu pedido?</p>
                                    <a href="https://wa.me/527712346620" style="display:inline-block; background-color:#25D366; color:white; padding:8px 16px; border-radius:20px; text-decoration:none; font-size:13px; font-weight:bold;">Escríbenos al WhatsApp</a>
                                </td>
                            </tr>
                            <tr>
                                <td style="background-color:#1f2937; padding:20px; text-align:center; color:#9ca3af; font-size:11px;">
                                    <p style="margin:5px 0;">Fresh Market Pachuca</p>
                                    <p style="margin:5px 0;">Frescura en cada producto🥕</p>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </body>
        </html>
        `;

        const tieneEmailCliente = !!(email && email.trim());
        const destinatarios = {
            from: '"Fresh Market" <pedidos@freshmarket.mx>',
            subject: `Pedido confirmado ${refId ? '#' + refId : ''} - Fresh Market 🥕`,
            html: htmlContent,
            attachments: [
                {
                    filename: 'logo.png',
                    path: path.join(__dirname, '../assets/freshmarket/logo.png'),
                    cid: 'logoFresh'
                }
            ]
        };

        if (tieneEmailCliente) {
            destinatarios.to = email.trim();
            destinatarios.bcc = CORREO_NEGOCIO; // copia al negocio
        } else {
            destinatarios.to = CORREO_NEGOCIO; // solo registro para el negocio
        }

        await transporter.sendMail(destinatarios);
        console.log(`✅ Confirmación de pedido ${refId} enviada (cliente: ${tieneEmailCliente ? email : 'sin email'})`);
        return true;
    } catch (error) {
        console.error("Error enviando confirmación de pedido:", error);
        return false;
    }
};

module.exports = { sendWelcomeEmail, sendSmartEmail, sendPinRecoveryEmail, sendOrderConfirmationEmail };