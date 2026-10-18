const jwt = require('jsonwebtoken');
const axios = require('axios');
const GoogleWalletObject = require('../models/GoogleWalletObject');
const Clientes = require('../models/Clientes');
const MarketingCampaign = require('../models/MarketingCampaign'); 
const { esStaging, bloqueado } = require('./entorno');

// Función de espera (Delay) para darle tiempo a Google a procesar
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// 👇 MODIFICADO: Acepta 'customData' para enviar mensajes manuales
async function updateGoogleWalletObject(clientId, customData = null) {
    // En staging no se toca la API de Google: los objetos de Wallet son los de
    // producción (mismo issuer), así que un PATCH desde pruebas alteraría el pase
    // real de un cliente y gastaría su cuota de 3 notificaciones/día.
    if (esStaging()) { bloqueado('Google Wallet', String(clientId)); return; }

    if (!SERVICE_ACCOUNT) return;

    try {
        const cliente = await Clientes.findById(clientId);
        if (!cliente) return;

        let walletObject = await GoogleWalletObject.findOne({ clienteId: clientId });
        if (!walletObject) {
            const constructedId = `${GOOGLE_ISSUER_ID}.${cliente._id}`;
            walletObject = await GoogleWalletObject.findOne({ objectId: constructedId });
        }
        if (!walletObject) {
            console.warn(`⚠️ GoogleWalletObject no encontrado para cliente ${clientId}. No se realizará el PATCH.`);
            return false;
        }

        // --- LÓGICA DE MENSAJE (Campaña Automática vs Manual) ---
        let promoTitle = "Novedades Fresh Market";
        let promoMessage = "🥕 ¡Sigue acumulando tus sellos!";
        
        // A) Si nos mandan datos manuales (desde la Interfaz), usamos eso
        if (customData && customData.title && customData.message) {
            promoTitle = customData.title;
            promoMessage = customData.message;
        } 
        // B) Si no, buscamos la última campaña en la base de datos
        else {
            try {
                const lastCampaign = await MarketingCampaign.findOne().sort({ sentAt: -1 });
                if (lastCampaign) {
                    promoTitle = lastCampaign.title || promoTitle;
                    promoMessage = lastCampaign.message || promoMessage;
                }
            } catch (e) {}
        }

        // Datos Visuales
        let numSellos = cliente.sellos || 0;
        const sellosVisuales = (numSellos > 0 && numSellos % 8 === 0) ? 8 : numSellos % 8;
        const imageName = `${sellosVisuales}-sello.png`;
        const heroImageUrl = `${BASE_URL}/public/freshmarket/niveles/${imageName}`;
        
        let totalGastado = cliente.totalGastado || 0;
        let selectedClassId = totalGastado >= 15000 ? CLASS_LEGEND : CLASS_NORMAL;
        
        const nombreLimpio = cliente.nombre ? cliente.nombre.split('-')[0].trim() : "Cliente Fresh";
        const realObjectId = walletObject.objectId;

        const accessToken = await getGoogleAccessToken();

        // 👇 LÓGICA DE PORTADA (LeDuo Style)
        const textoPortada = numSellos >= 8 
            ? "🎁 ¡Premio disponible!" 
            : `${sellosVisuales}/8 sellos • $${(cliente.puntos || 0).toFixed(0)} pts`;

        // ---------------------------------------------------------
        // PASO 1: PATCH (Actualizar visuales + Limpiar mensajes)
        // ---------------------------------------------------------
        const patchBody = {
            classId: selectedClassId,
            state: 'ACTIVE',
            accountName: textoPortada, // Aquí va el texto dinámico de portada
            loyaltyPoints: {
                label: 'Puntos',
                balance: { string: `$${(cliente.puntos || 0).toFixed(2)}` }
            },
            secondaryLoyaltyPoints: {
                label: 'Mis Sellos',
                balance: { string: `${sellosVisuales} de 8` }
            },
            heroImage: { sourceUri: { uri: heroImageUrl } },
            textModulesData: [
                {
                    header: "Titular",
                    body: nombreLimpio, // Nombre del cliente movido aquí
                    id: "account_holder"
                },
                {
                    header: "Última Noticia",
                    body: promoTitle,
                    id: "latest_news_static"
                }
            ],
            // 🧹 ESTO BORRA LOS MENSAJES ANTERIORES
            messages: [] 
        };

        await axios.patch(
            `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${realObjectId}`,
            patchBody,
            { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
        );

        console.log(`🧹 Pase actualizado y limpiado para ${clientId}`);

        // ---------------------------------------------------------
        // ⏳ PASO INTERMEDIO: ESPERA (CRUCIAL)
        // ---------------------------------------------------------
        await sleep(1500); 

        // ---------------------------------------------------------
        // PASO 2: ADD MESSAGE (Disparar Notificación)
        // ---------------------------------------------------------
        const messageId = `promo_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        
        const addMessageBody = {
            message: {
                header: promoTitle.substring(0, 50),
                body: promoMessage,
                id: messageId,
                messageType: "TEXT_AND_NOTIFY", // 🔔 Forzar notificación
                displayInterval: {
                    start: { date: new Date().toISOString() },
                    end: { date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() } // 3 días vigencia
                }
            }
        };

        try {
            await axios.post(
                `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${realObjectId}/addMessage`,
                addMessageBody,
                { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
            );
            console.log(`🔔 Notificación PUSH enviada a ${clientId}`);
        } catch (msgErr) {
            if (msgErr.response?.data?.error?.message?.includes("QuotaExceeded")) {
                console.warn(`⚠️ Límite de notificaciones (3/día) alcanzado para ${clientId}`);
            } else {
                console.error("❌ Error enviando AddMessage:", JSON.stringify(msgErr.response?.data || msgErr.message));
            }
        }

        // Guardar versión en DB
        await GoogleWalletObject.findOneAndUpdate(
            { _id: walletObject._id },
            { classId: selectedClassId, version: walletObject.version + 1, updatedAt: new Date() }
        );
        return true;

    } catch (err) {
        console.error(`❌ Error Critical Google API (${clientId}):`, err.response?.data?.error || err.message);
        return false;
    }
}

// 👇 MODIFICADO: Exporta la función aceptando los dos parámetros
async function notifyGoogleWalletUpdate(clientId, customData = null) {
    try {
        const ok = await updateGoogleWalletObject(clientId, customData);
        return ok;
    } catch (err) {
        console.error('❌ Error fatal en notifyGoogleWalletUpdate:', err);
        return false;
    }
}

module.exports = {
    updateGoogleWalletObject,
    notifyGoogleWalletUpdate
};