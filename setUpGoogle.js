const jwt = require('jsonwebtoken');
const axios = require('axios');
// const fs = require('fs'); // Ya no necesitamos fs para leer archivos locales

// TUS DATOS REALES
const ISSUER_ID = '3388000000023046225'; 
const SERVICE_ACCOUNT = require('./keys.json'); 

// CONFIGURACIÓN DE TU TARJETA
const classId = `${ISSUER_ID}.fresh_market_loyal`; 

const loyaltyClass = {
  "id": classId,
  "issuerName": "Fresh Market",
  "programName": "Fidelity Rewards",
  "programLogo": {
    "sourceUri": {
      // ⚠️ IMPORTANTE: Debe ser una URL pública.
      "uri": "https://i.ibb.co/1G5kMjc4/logo.png" 
    }
  },
  "reviewStatus": "UNDER_REVIEW", 
  "hexBackgroundColor": "#10B981", 
  "heroImage": {
    "sourceUri": {
      // Banner de comida saludable genérico (URL pública)
      "uri": "https://images.unsplash.com/photo-1542838132-92c53300491e?q=80&w=1000&auto=format&fit=crop"
    }
  },
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

async function createClass() {
  try {
    console.log("🔄 Conectando con Google Wallet...");

    // 1. Crear Token de Seguridad
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

    // 2. Obtener Permiso
    const authResponse = await axios.post(
      "https://www.googleapis.com/oauth2/v4/token",
      `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${token}`,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    
    const googleToken = authResponse.data.access_token;

    // 3. Crear la Clase (Plantilla)
    const response = await axios.post(
      `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyClass`,
      loyaltyClass,
      {
        headers: {
          Authorization: `Bearer ${googleToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ ¡ÉXITO! La clase se creó correctamente.");
    console.log("Class ID:", response.data.id);

  } catch (error) {
    if (error.response) {
        // Si dice "Entity already exists", ¡es buena noticia!
        if (error.response.status === 409) {
             console.log("✅ ¡LISTO! La clase YA EXISTÍA. No necesitas hacer nada más.");
        } else {
             console.log("⚠️ Respuesta de Google:", JSON.stringify(error.response.data, null, 2));
        }
    } else {
        console.error("❌ Error:", error.message);
    }
  }
}

createClass();