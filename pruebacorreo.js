const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: 'smtpout.secureserver.net', // 👈 ESTE ES EL CORRECTO SEGÚN TUS DNS
    port: 465,
    secure: true, 
    auth: {
    }
});

async function probar() {
    try {
        console.log("Intentando conectar con GoDaddy SecureServer...");
        await transporter.verify();
        console.log("✅ ¡Conexión Exitosa!");

        const info = await transporter.sendMail({
            from: '"Fresh Market Pachuca" <pedidos@freshmarket.mx>',
            to: "nahumpl95@gmail.com", // Tu correo personal
            subject: "Prueba Final 🚀",
            text: "Funcionó con smtpout.secureserver.net"
        });

        console.log("✅ Correo enviado:", info.messageId);
    } catch (error) {
        console.error("❌ Error:", error);
    }
}

probar();