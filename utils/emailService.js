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
    logger: true,
    debug: true
});

const sendWelcomeEmail = async (email, nombre, clienteId) => {
    try {
        console.log(`📧 Intentando enviar bienvenida a: ${email}`);
        
        const nombreLimpio = nombre ? nombre.split(' ')[0] : 'Cliente';
        const walletLinkApple = `https://backendfresh-production.up.railway.app/api/wallet/download/apple/${clienteId}`;
        const walletLinkGoogle = `https://backendfresh-production.up.railway.app/api/wallet/google/${clienteId}`;
        const whatsappLink = "https://wa.me/527712346620";

        // Estilos base para los botones negros
        const buttonStyle = "display: block; width: 200px; background-color: #000000; border-radius: 10px; padding: 8px 16px; text-decoration: none; margin: 0 auto 10px auto;";
        const textSmall = "color: #aaaaaa; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; line-height: 1.2;";
        const textLarge = "color: #ffffff; font-size: 16px; font-weight: bold; line-height: 1.2;";

        const htmlContent = `
        <div style="font-family: 'Helvetica Neue', Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
            
            <div style="background-color: #ffffff; padding: 10px; text-align: center; border-bottom: 4px solid #15803d;">
                <img src="cid:logoFresh" alt="Fresh Market" style="width: 80px; height: auto;" />
            </div>

            <div style="background-color: #15803d; padding: 20px; text-align: center;">
                <h1 style="color: white; margin: 0; font-size: 22px;">¡Bienvenido a Fresh Market! 🥕</h1>
            </div>

            <div style="padding: 30px;">
                <h2 style="color: #15803d; margin-top: 0;">Hola, ${nombreLimpio} 👋</h2>
                <p style="font-size: 16px; line-height: 1.6; color: #555;">
                    Gracias por unirte, podrás recibir novedades, promociones exclusivas y acceder a nuestra nueva plataforma para hacer tus pedidos más sencillos, así como gestionar tu tarjeta digital de lealtad.
                </p>
                
                <div style="background-color: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 12px; padding: 25px; margin: 25px 0; text-align: center;">
                    <p style="margin: 0 0 5px; font-weight: bold; color: #166534; font-size: 18px;">🎁 Tu Tarjeta Digital</p>
                    <p style="margin: 0 0 20px; font-size: 14px; color: #64748b;">Llévala siempre contigo y gana premios.</p>
                    
                    <a href="${walletLinkApple}" style="${buttonStyle}">
                        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                                <td width="30" style="padding-right: 10px;">
                                    <img src="cid:iconApple" width="28" alt="Apple" style="display: block;" />
                                </td>
                                <td style="text-align: left;">
                                    <div style="${textSmall}">Añadir a</div>
                                    <div style="${textLarge}">Apple Wallet</div>
                                </td>
                            </tr>
                        </table>
                    </a>

                    <a href="${walletLinkGoogle}" style="${buttonStyle}">
                        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                                <td width="30" style="padding-right: 10px;">
                                    <img src="cid:iconGoogle" width="28" alt="Google" style="display: block;" />
                                </td>
                                <td style="text-align: left;">
                                    <div style="${textSmall}">Añadir a</div>
                                    <div style="${textLarge}">Google Wallet</div>
                                </td>
                            </tr>
                        </table>
                    </a>
                </div>

                <div style="text-align: center; margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee;">
                    <p style="font-size: 14px; color: #666; margin-bottom: 15px;">
                        ¿Necesitas hacer un pedido o tienes dudas?
                    </p>
                    <a href="${whatsappLink}" style="display: inline-block; background-color: #25D366; color: white; padding: 10px 25px; text-decoration: none; border-radius: 50px; font-weight: bold; font-size: 15px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
                        💬 Contactar por WhatsApp
                    </a>
                </div>

            </div>
            
            <div style="background-color: #f9fafb; padding: 20px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #eee;">
                <p style="margin: 0;">Fresh Market Pachuca - Frescura a tu puerta</p>
            </div>
        </div>
        `;

        // Versión Texto Plano
        const textContent = `Hola ${nombreLimpio}, bienvenido a Fresh Market.\n\nDescarga tu tarjeta digital:\niPhone: ${walletLinkApple}\nAndroid: ${walletLinkGoogle}\n\nSoporte WhatsApp: ${whatsappLink}`;

        const info = await transporter.sendMail({
            from: '"Fresh Market" <pedidos@freshmarket.mx>',
            to: email,
            subject: "🥕 ¡Bienvenido a Fresh Market!",
            text: textContent,
            html: htmlContent,
            attachments: [
                {
                    filename: 'logo.png',
                    path: path.join(__dirname, '../assets/freshmarket/logo.png'),
                    cid: 'logoFresh'
                },
                // 👇 NUEVOS ICONOS PARA LOS BOTONES
                {
                    filename: 'appleWalletIcon.png',
                    path: path.join(__dirname, '../assets/freshmarket/appleWalletIcon.png'), // Verifica mayúsculas/minúsculas
                    cid: 'iconApple'
                },
                {
                    filename: 'googleWalletIcon.png',
                    path: path.join(__dirname, '../assets/freshmarket/googleWalletIcon.png'),
                    cid: 'iconGoogle'
                }
            ]
        });

        console.log(`✅ Correo enviado con éxito ID: ${info.messageId}`);
        return true;
    } catch (error) {
        console.error("❌ Error enviando correo:", error);
        return false;
    }
};

module.exports = { sendWelcomeEmail };