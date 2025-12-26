const jwt = require('jsonwebtoken');
const axios = require('axios');

// 1. TUS DATOS
const ISSUER_ID = '3388000000023046225';
const SERVICE_ACCOUNT = require('./keys.json'); // Asegúrate de tener keys.json en la misma carpeta

const classId = `${ISSUER_ID}.fresh_market_loyal`;

// 2. EL DISEÑO NUEVO QUE QUIERES
const loyaltyClass = {
    "id": classId,
    "issuerName": "Fresh Market",
    "programName": "Recompensas Fresh Market",
    "programLogo": {
        "sourceUri": {
            "uri": "https://i.ibb.co/1G5kMjc4/logo.png" // Tu logo
        }
    },
    "reviewStatus": "UNDER_REVIEW",
    "hexBackgroundColor": "#228b22", // Tu color verde

    // ⚠️ IMPORTANTE: Dejamos esto COMENTADO o lo borramos.
    // Al no enviarlo, Google quita la imagen por defecto de la plantilla.
    // Esto permite que tu código 'wallet.js' ponga la imagen de los sellos dinámicamente.
    /*
    "heroImage": {
      "sourceUri": {
        "uri": "https://..."
      }
    },
    */

    "contentTemplate": {
        "items": [
            {
                "firstValue": {
                    "fields": [{ "fieldPath": "object.loyaltyPoints.balance.string" }]
                },
                "secondValue": {
                    "fields": [{ "fieldPath": "object.loyaltyPoints.label" }]
                }
            }
        ]
    }
};

async function updateClass() {
    try {
        console.log("🔄 Actualizando Clase en Google Wallet...");

        // A. Autenticación (Standard)
        const token = jwt.sign(
            {
                iss: SERVICE_ACCOUNT.client_email,
                sub: SERVICE_ACCOUNT.client_email,
                aud: "https://www.googleapis.com/oauth2/v4/token",
                exp: Math.floor(Date.now() / 1000) + 3600,
                scope: "https://www.googleapis.com/auth/wallet_object.issuer"
            },
            SERVICE_ACCOUNT.private_key,
            { algorithm: "RS256" }
        );

        const authResponse = await axios.post(
            "https://www.googleapis.com/oauth2/v4/token",
            `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${token}`,
            { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
        );
        const googleToken = authResponse.data.access_token;

        // B. LA DIFERENCIA CLAVE: Usamos PUT y la URL incluye el ID
        const response = await axios.put(
            `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyClass/${classId}`,
            loyaltyClass,
            {
                headers: {
                    Authorization: `Bearer ${googleToken}`,
                    "Content-Type": "application/json"
                }
            }
        );

        console.log("✅ ¡ÉXITO! Diseño actualizado correctamente.");
        console.log("Ahora la plantilla está limpia para recibir tus imágenes dinámicas.");

    } catch (error) {
        console.error("❌ Error:", error.response ? error.response.data : error.message);
    }
}

updateClass();