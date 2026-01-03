const apn = require('apn');
const path = require('path');
const WalletDevice = require('../models/WalletDevice');
const { notifyGoogleWalletUpdate } = require('./pushGoogle');

// =========================================================
// CONFIGURACIÓN APN (TU CÓDIGO ORIGINAL)
// =========================================================
const options = {
    cert: path.join(__dirname, '../certs/signerCert.pem'),
    key: path.join(__dirname, '../certs/signerKey.pem'),
    production: true // Siempre true para Wallet
};

const apnProvider = new apn.Provider(options);

// =========================================================
// FUNCIÓN PRINCIPAL DE NOTIFICACIÓN
// =========================================================
async function notifyPassUpdate(clientId) {
    const serialNumber = `FRESH-${clientId}`;

    // -----------------------------------------------------
    // 1. INTENTAR APPLE 🍏
    // -----------------------------------------------------
    try {
        // Buscar iPhones registrados
        const devices = await WalletDevice.find({ serialNumber: serialNumber });

        if (devices.length === 0) {
            console.log(`ℹ️ No hay dispositivos Apple registrados para ${serialNumber}`);
            // ⚠️ CLAVE: NO HACEMOS 'RETURN' AQUÍ. DEJAMOS QUE EL CÓDIGO SIGA.
        } else {
            console.log(`🔔 Enviando Push a ${devices.length} dispositivos para ${serialNumber}...`);

            // Tu lógica de envío intacta
            const note = new apn.Notification();
            note.expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hora
            note.payload = {}; // Payload vacío

            const tokens = devices.map(d => d.pushToken);
            const result = await apnProvider.send(note, tokens);

            if (result.sent.length > 0) {
                console.log(`✅ Push enviado con éxito a ${result.sent.length} dispositivos Apple.`);
            }
            if (result.failed.length > 0) {
                console.error(`❌ Falló envío a ${result.failed.length} dispositivos:`, result.failed);
            }
        }
    } catch (err) {
        console.error("❌ Error en el bloque Apple:", err);
    }

    // -----------------------------------------------------
    // 2. INTENTAR GOOGLE 🤖 (SE EJECUTA SIEMPRE)
    // -----------------------------------------------------
    // Ahora está en su propio bloque try/catch para seguridad total
    try {
        await notifyGoogleWalletUpdate(clientId);
    } catch (err) {
        console.error("❌ Error notificando Google Wallet:", err.message);
    }
}

module.exports = notifyPassUpdate;