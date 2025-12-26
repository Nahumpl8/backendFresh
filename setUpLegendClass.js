const jwt = require('jsonwebtoken');
const axios = require('axios');

// TUS DATOS
const ISSUER_ID = '3388000000023046225'; 
const SERVICE_ACCOUNT = require('./keys.json'); 

// 🏆 NUEVA CLASE PARA USUARIOS PREMIUM
const classId = `${ISSUER_ID}.fresh_market_legend`; 

const loyaltyClass = {
  "id": classId,
  "issuerName": "Fresh Market",
  "programName": "Legend Fresh Market", // Nombre especial
  "programLogo": {
    "sourceUri": {
      "uri": "https://i.ibb.co/1G5kMjc4/logo.png" 
    }
  },
  "reviewStatus": "UNDER_REVIEW", 
  "hexBackgroundColor": "#f97316", // Color naranja VIP
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

async function createGoldClass() {
  try {
    console.log("🏆 Creando Clase Legend Fresh en Google Wallet...");

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

    // CREAMOS LA CLASE
    try {
        const response = await axios.post(
        `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyClass`,
        loyaltyClass,
        { headers: { Authorization: `Bearer ${googleToken}`, "Content-Type": "application/json" } }
        );
        console.log("✅ ¡ÉXITO! Clase Legend creada:", response.data.id);
    } catch (e) {
        if(e.response && e.response.status === 409) {
            console.log("✅ La clase Legend ya existía. Todo listo.");
        } else {
            throw e;
        }
    }

  } catch (error) {
     console.error("❌ Error:", error.response ? error.response.data : error.message);
  }
}

createGoldClass();