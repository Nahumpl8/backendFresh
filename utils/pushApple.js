const apn = require('apn');
const path = require('path');
const WalletDevice = require('../models/WalletDevice');
const { notifyGoogleWalletUpdate } = require('./pushGoogle');

// Configuración del proveedor APN
// Usamos tus mismos certificados. Generalmente el signerCert y signerKey 
// funcionan para APN si son de tipo "Pass Type ID".
const options = {
    cert: path.join(__dirname, '../certs/signerCert.pem'),
    key: path.join(__dirname, '../certs/signerKey.pem'),
    production: true // Siempre true para Wallet
};

const apnProvider = new apn.Provider(options);

async function notifyPassUpdate(clientId) {
    const serialNumber = `FRESH-${clientId}`;

    try {
        // 1. Buscar todos los iPhones que tienen este pase
        const devices = await WalletDevice.find({ serialNumber: serialNumber });

        if (devices.length === 0) {
            console.log(`ℹ️ No hay dispositivos registrados para ${serialNumber}`);
            return;
        }

        console.log(`🔔 Enviando Push a ${devices.length} dispositivos para ${serialNumber}...`);

        // 2. Enviar notificación vacía (Así funciona Wallet, solo despierta al cel)
        const note = new apn.Notification();
        note.expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hora
        note.payload = {}; // Payload vacío es la clave

        // Extraemos los tokens
        const tokens = devices.map(d => d.pushToken);

        // 3. Enviar
        const result = await apnProvider.send(note, tokens);

        if (result.sent.length > 0) {
            console.log(`✅ Push enviado con éxito a ${result.sent.length} dispositivos.`);
        }
        if (result.failed.length > 0) {
            console.error(`❌ Falló envío a ${result.failed.length} dispositivos:`, result.failed);
        }

        // También notificar Google Wallet
        await notifyGoogleWalletUpdate(clientId).catch(err => {
            console.error("❌ Error notificando Google Wallet:", err);
        });

    } catch (err) {
        console.error("❌ Error en pushApple:", err);
    }
}

module.exports = notifyPassUpdate;