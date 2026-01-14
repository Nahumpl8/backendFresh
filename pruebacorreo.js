const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
dotenv.config();

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST, // 👈 ESTE ES EL CORRECTO SEGÚN TUS DNS
    port: 465,
    secure: true, 
    auth: {
        user: process.env.EMAIL_USER, 
        pass: process.env.EMAIL_PASS  
    }
});

async function probar() {
    try {
        console.log("Intentando conectar con Titan Mail...");
        await transporter.verify();
        console.log("✅ ¡Conexión Exitosa!");

        const info = await transporter.sendMail({
            from: '"Fresh Market Pachuca" <pedidos@freshmarket.mx>',
            to: "nahumpl95@gmail.com", // Tu correo personal
            subject: "Prueba Final 🚀 titan mail",
            text: "Funcionó con smtpout.secureserver.net"
        });

        console.log("✅ Correo enviado:", info.messageId);
    } catch (error) {
        console.error("❌ Error:", error);
    }
}

probar();