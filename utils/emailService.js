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

        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 20px;">
            <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 10px; overflow: hidden;">
                <div style="background-color: #15803d; padding: 20px; text-align: center; color: white;">
                    <h1>¡Bienvenido a Fresh Market! 🥕</h1>
                </div>
                <div style="padding: 20px; color: #333;">
                    <p>Hola <strong>${nombre}</strong>,</p>
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

module.exports = { sendWelcomeEmail, sendSmartEmail };