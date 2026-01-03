const jwt = require('jsonwebtoken');
const axios = require('axios');

// TUS DATOS
const ISSUER_ID = '3388000000023046225'; 
const SERVICE_ACCOUNT = require('./keys.json'); 

const classId = `${ISSUER_ID}.fresh_market_loyal`; 

// LA NUEVA CONFIGURACIÓN (Sin heroImage)
const loyaltyClass = {
  "id": classId,
  "issuerName": "Fresh Market",
  "programName": "Fidelify Rewards",
  "programLogo": {
    "sourceUri": {
      "uri": "https://i.ibb.co/1G5kMjc4/logo.png" 
    }
  },
  "reviewStatus": "UNDER_REVIEW", 
  "hexBackgroundColor": "#10B981", 
  // ❌ COMENTAMOS ESTO PARA QUE NO HAYA IMAGEN POR DEFECTO
  /*
  "heroImage": {
    "sourceUri": {
      "uri": "https://images.unsplash.com/..."
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

    // 1. Token
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

    // 2. Auth
    const authResponse = await axios.post(
      "https://www.googleapis.com/oauth2/v4/token",
      `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${token}`,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const googleToken = authResponse.data.access_token;

    // 3. ACTUALIZAR (Usamos PUT en lugar de POST y agregamos el ID a la URL)
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

    console.log("✅ ¡ÉXITO! La clase se actualizó (Adiós verduras).");
    console.log("Class ID:", response.data.id);

  } catch (error) {
     console.error("❌ Error:", error.response ? error.response.data : error.message);
  }
}

updateClass();