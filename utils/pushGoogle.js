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
        const keyPath = path.join(__dirname, '../keys.json');
        if (require('fs').existsSync(keyPath)) {
            SERVICE_ACCOUNT = require('../keys.json');
        }
    }
} catch (err) {
    console.error("❌ Error cargando credenciales Google:", err.message);
}

const GOOGLE_ISSUER_ID = '3388000000023046225';
const BASE_URL = process.env.BASE_URL || 'https://backendfresh-production.up.railway.app';
const CLASS_NORMAL = `${GOOGLE_ISSUER_ID}.fresh_market_loyal`;
const CLASS_LEGEND = `${GOOGLE_ISSUER_ID}.fresh_market_legend`;

// Obtener token de acceso de Google
async function getGoogleAccessToken() {
    if (!SERVICE_ACCOUNT) {
        throw new Error('No hay credenciales de Google Wallet configuradas');
    }

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
        // Buscar cliente
        const cliente = await Clientes.findById(clientId);
        if (!cliente) {
            console.log(`⚠️ Cliente ${clientId} no encontrado`);
            return;
        }

        // Buscar objeto de wallet existente
        const objectId = `${GOOGLE_ISSUER_ID}.${cliente._id}`;
        const walletObject = await GoogleWalletObject.findOne({ objectId });

        if (!walletObject) {
            console.log(`⚠️ No hay objeto de Google Wallet para cliente ${clientId}`);
            return;
        }

        // Calcular datos actualizados
        let numSellos = cliente.sellos || 0;
        if (numSellos > 8) numSellos = 8;

        const imageName = `${numSellos}-sello.png`;
        const heroImageUrl = `${BASE_URL}/public/freshmarket/niveles/${imageName}`;

        let selectedClassId = CLASS_NORMAL;
        if (numSellos > 5) {
            selectedClassId = CLASS_LEGEND;
        }

        const nombreLimpio = cliente.nombre ? cliente.nombre.split('-')[0].trim() : "Cliente Fresh";

        // Construir objeto actualizado
        const updatedObject = {
            id: objectId,
            classId: selectedClassId,
            state: 'ACTIVE',
            accountId: cliente.telefono,
            version: walletObject.version + 1, // Incrementar versión
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
                    { kind: "i18n.WALLET_URI_PHONE", uri: "WhatsApp: wa.me/7712346620", description: "Llamar a Fresh Market" },
                    { kind: "i18n.WALLET_URI_WEB", uri: "https://facebook.com/freshmarketp", description: "Facebook" }
                ]
            }
        };

        // Obtener token de acceso
        const accessToken = await getGoogleAccessToken();

        // Actualizar objeto usando PUT
        await axios.put(
            `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${objectId}`,
            updatedObject,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // Actualizar en BD
        await GoogleWalletObject.findOneAndUpdate(
            { objectId },
            {
                classId: selectedClassId,
                version: walletObject.version + 1,
                updatedAt: new Date()
            }
        );

        console.log(`✅ Google Wallet actualizado para cliente ${clientId}`);

    } catch (err) {
        console.error(`❌ Error actualizando Google Wallet para ${clientId}:`, err.response?.data || err.message);
    }
}

// Notificar cambios a Google Wallet
async function notifyGoogleWalletUpdate(clientId) {
    try {
        await updateGoogleWalletObject(clientId);
    } catch (err) {
        console.error('❌ Error en notificación Google Wallet:', err);
    }
}

module.exports = {
    updateGoogleWalletObject,
    notifyGoogleWalletUpdate
};

