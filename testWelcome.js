require('dotenv').config();
const { sendWelcomeEmail } = require('./utils/emailService');

// Pon un ID de cliente real de tu base de datos si quieres que el link de wallet funcione, 
// o uno inventado solo para ver si llega el correo.
const fakeId = "663a4574d6a6587ff7272e96"; 

sendWelcomeEmail('clauudlvalle@gmail.com', 'Prueba Manual', fakeId);