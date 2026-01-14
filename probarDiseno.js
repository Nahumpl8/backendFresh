require('dotenv').config(); // Cargar las claves de GoDaddy
const { sendWelcomeEmail } = require('./utils/emailService');

// DATOS FALSOS PARA LA PRUEBA
const miCorreo = "nahumpl95@gmail.com"; // 👈 PON TU CORREO AQUÍ
const nombrePrueba = "Nahum";
const idFalso = "663a4574d6a6587ff7272z96"; // Un ID de MongoDB cualquiera para generar el link

async function test() {
    console.log("🎨 Iniciando prueba de diseño...");
    
    // Llamamos a la función real que acabamos de crear
    const exito = await sendWelcomeEmail(miCorreo, nombrePrueba, idFalso);

    if (exito) {
        console.log("✅ ¡Correo enviado! Revisa tu bandeja de entrada (y spam).");
        console.log("🖼️ Verifica que el logo se vea y el botón de WhatsApp funcione.");
    } else {
        console.log("❌ Hubo un error. Revisa los logs de arriba.");
    }
}

test();