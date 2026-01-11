const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: true,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Plantilla de Bienvenida
const sendWelcomeEmail = async (email, nombre, clienteId) => {
    try {
        const nombreLimpio = nombre ? nombre.split(' ')[0] : 'Cliente';

        // Links inteligentes (usa /go/ para simplificar)
        const walletLink = `https://backendfresh-production.up.railway.app/api/wallet/go/${clienteId}`;

        const htmlContent = `
        <div style="font-family: 'Helvetica Neue', Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 12px; overflow: hidden;">
            
            <div style="background-color: #15803d; padding: 30px 20px; text-align: center;">
                <h1 style="color: white; margin: 0; font-size: 24px;">¡Bienvenido a Fresh Market! 🥕</h1>
            </div>

            <div style="padding: 30px;">
                <h2 style="color: #15803d; margin-top: 0;">Hola, ${nombreLimpio} 👋</h2>
                <p style="font-size: 16px; line-height: 1.6; color: #555;">
                    Gracias por unirte. Nos encanta tenerte aquí.
                    En Fresh Market nos dedicamos a llevarte los productos más frescos del campo a tu mesa.
                </p>

                <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 20px; margin: 25px 0; text-align: center;">
                    <p style="margin: 0; font-weight: bold; font-size: 18px; color: #166534;">🎁 Tu Tarjeta Digital</p>
                    <p style="margin: 10px 0; color: #166534;">Acumula sellos en cada compra y gana productos gratis.</p>
                    
                    <a href="${walletLink}" style="display: inline-block; background-color: #15803d; color: white; padding: 12px 28px; text-decoration: none; border-radius: 50px; font-weight: bold; margin-top: 10px;">
                        📲 Descargar mi Wallet
                    </a>
                </div>

                <p style="font-size: 14px; color: #888; margin-top: 30px;">
                    Si tienes alguna duda o quieres hacer tu primer pedido, solo responde a este correo o escríbenos por WhatsApp.
                </p>
            </div>
            
            <div style="background-color: #f9fafb; padding: 20px; text-align: center; font-size: 12px; color: #999;">
                <p>Fresh Market Pachuca - Frescura a tu puerta</p>
            </div>
        </div>
        `;

        await transporter.sendMail({
            from: '"Fresh Market" <pedidos@freshmarket.mx>',
            to: email,
            subject: "🥕 ¡Bienvenido a la familia Fresh Market!",
            html: htmlContent
        });

        console.log(`✅ Bienvenida enviada a: ${email}`);
        return true;
    } catch (error) {
        console.error("❌ Error enviando bienvenida:", error);
        return false;
    }
};

module.exports = { sendWelcomeEmail };