const apn = require('apn');
const path = require('path');
const WalletDevice = require('../models/WalletDevice');

// =========================================================
// CONFIGURACIÓN APN
// =========================================================
const options = {
    cert: path.join(__dirname, '../certs/signerCert.pem'),
    key: path.join(__dirname, '../certs/signerKey.pem'),
    production: true // Wallet siempre requiere production: true
};

const apnProvider = new apn.Provider(options);

// =========================================================
// FUNCIÓN PRINCIPAL DE NOTIFICACIÓN
// =========================================================
async function notifyPassUpdate(clientId) {
    const serialNumber = `FRESH-${clientId}`;

    try {
        // 1. Buscar dispositivos registrados en Mongo
        const devices = await WalletDevice.find({ serialNumber: serialNumber });

        if (devices.length === 0) {
            console.log(`ℹ️ Apple: No hay dispositivos registrados para ${serialNumber}`);
            return;
        }

        console.log(`🍏 Enviando Push a ${devices.length} dispositivos Apple...`);

        // 2. Configurar la notificación vacía (Ping)
        const note = new apn.Notification();
        note.expiry = Math.floor(Date.now() / 1000) + 3600; // Expira en 1 hora
        note.payload = {}; // El payload SIEMPRE va vacío para Wallet
        
        // 👇 ESENCIAL: Debes especificar el Topic (Tu Pass Type ID)
        note.topic = "pass.com.freshmarket.pachuca"; 

        // 3. Enviar
        const tokens = devices.map(d => d.pushToken);
        const result = await apnProvider.send(note, tokens);

        // 4. Log de resultados
        if (result.sent.length > 0) {
            console.log(`✅ Apple: Enviado con éxito a ${result.sent.length} dispositivo(s).`);
        }
        
        if (result.failed.length > 0) {
            console.error("❌ Apple: Falló el envío a algunos dispositivos:", JSON.stringify(result.failed));
            // Opcional: Aquí podrías borrar los tokens inválidos de la BD
        }

    } catch (err) {
        console.error("❌ Error crítico en pushApple:", err);
    }
}

module.exports = notifyPassUpdate;