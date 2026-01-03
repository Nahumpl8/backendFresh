const jwt = require('jsonwebtoken');
const axios = require('axios');
const GoogleWalletObject = require('../models/GoogleWalletObject');
const Clientes = require('../models/Clientes');

// Cargar credenciales
let SERVICE_ACCOUNT = null;
try {
    if (process.env.GOOGLE_KEY_JSON) {
        SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_KEY_JSON);
    } else {
        const path = require('path');
        const keyPath = path.join(__dirname, '../keys.json'); // Ajusta la ruta si es necesario
        if (require('fs').existsSync(keyPath)) {
            SERVICE_ACCOUNT = require('../keys.json');
        }
    }
} catch (err) {
    console.error("❌ Error cargando credenciales Google:", err.message);
}

const GOOGLE_ISSUER_ID = '3388000000023046225';
// Asegúrate de que esta URL sea la de producción
const BASE_URL = process.env.BASE_URL || 'https://backendfresh-production.up.railway.app';
const CLASS_NORMAL = `${GOOGLE_ISSUER_ID}.fresh_market_loyal`;
const CLASS_LEGEND = `${GOOGLE_ISSUER_ID}.fresh_market_legend`;

// Obtener token de acceso de Google
async function getGoogleAccessToken() {
    if (!SERVICE_ACCOUNT) throw new Error('No hay credenciales de Google Wallet');

    const token = jwt.sign(
        {
            iss: SERVICE_ACCOUNT.client_email,
            sub: SERVICE_ACCOUNT.client_email,
            aud: 'https://www.googleapis.com/oauth2/v4/token',
            exp: Math.floor(Date.now() / 1000) + 3600,
            scope: 'https://www.googleapis.com/auth/wallet_object.issuer'
        },
        SERVICE_ACCOUNT.private_key,
        { algorithm: 'RS256' }
    );

    const authResponse = await axios.post(
        'https://www.googleapis.com/oauth2/v4/token',
        `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${token}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    return authResponse.data.access_token;
}

// Actualizar objeto de Google Wallet
async function updateGoogleWalletObject(clientId) {
    if (!SERVICE_ACCOUNT) {
        console.log('⚠️ No hay credenciales Google Wallet, saltando actualización');
        return;
    }

    try {
        // 1. Buscar cliente
        const cliente = await Clientes.findById(clientId);
        if (!cliente) {
            console.log(`⚠️ Cliente ${clientId} no encontrado en DB`);
            return;
        }

        // =========================================================
        // 🔑 EL CAMBIO CLAVE ESTÁ AQUÍ
        // Buscamos por el ID DEL CLIENTE, no por el ID del objeto inventado
        // =========================================================
        let walletObject = await GoogleWalletObject.findOne({ clienteId: clientId });

        // Fallback: Si no lo encontramos por clienteId, intentamos la forma vieja por si acaso
        if (!walletObject) {
            const constructedId = `${GOOGLE_ISSUER_ID}.${cliente._id}`;
            walletObject = await GoogleWalletObject.findOne({ objectId: constructedId });
        }

        if (!walletObject) {
            console.log(`⚠️ No hay objeto de Google Wallet para cliente ${clientId}`);
            return; // Aquí se detiene si no encuentra nada
        }

        // =========================================================
        
        // 3. Calcular datos
        let numSellos = cliente.sellos || 0;
        if (numSellos > 8) numSellos = 8;
        const imageName = `${numSellos}-sello.png`;
        const heroImageUrl = `${BASE_URL}/public/freshmarket/niveles/${imageName}`;
        let selectedClassId = numSellos > 5 ? CLASS_LEGEND : CLASS_NORMAL;
        
        const nombreLimpio = cliente.nombre ? cliente.nombre.split('-')[0].trim() : "Cliente Fresh";
        const realObjectId = walletObject.objectId; // Usamos el ID real de la base de datos

        // 4. Construir JSON para Google
        const updatedObject = {
            id: realObjectId,
            classId: selectedClassId,
            state: 'ACTIVE',
            accountId: cliente.telefono,
            version: walletObject.version + 1,
            barcode: {
                type: 'QR_CODE',
                value: cliente._id.toString(),
                alternateText: "fidelity.mx"
            },
            accountName: nombreLimpio,
            loyaltyPoints: {
                label: 'Puntos',
                balance: { string: (cliente.puntos || 0).toString() }
            },
            secondaryLoyaltyPoints: {
                label: 'Sellos',
                balance: { string: `${numSellos}/8` }
            },
            heroImage: { sourceUri: { uri: heroImageUrl } },
            linksModuleData: {
                uris: [
                    { kind: "i18n.WALLET_URI_PHONE", uri: "tel:7711234567", description: "Llamar" },
                    { kind: "i18n.WALLET_URI_WEB", uri: "https://facebook.com/freshmarketp", description: "Facebook" }
                ]
            }
        };

        // 5. Enviar a Google
        const accessToken = await getGoogleAccessToken();
        await axios.put(
            `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${realObjectId}`,
            updatedObject,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // 6. Guardar en nuestra DB
        await GoogleWalletObject.findOneAndUpdate(
            { _id: walletObject._id },
            {
                classId: selectedClassId,
                version: walletObject.version + 1,
                updatedAt: new Date()
            }
        );

        console.log(`✅ Google Wallet actualizado para cliente ${clientId}`);

    } catch (err) {
        const googleError = err.response?.data?.error?.message || err.message;
        console.error(`❌ Error Google API (${clientId}):`, googleError);
    }
}

// Notificar cambios
async function notifyGoogleWalletUpdate(clientId) {
    try {
        await updateGoogleWalletObject(clientId);
    } catch (err) {
        console.error('❌ Error fatal en notifyGoogleWalletUpdate:', err);
    }
}

module.exports = {
    updateGoogleWalletObject,
    notifyGoogleWalletUpdate
};