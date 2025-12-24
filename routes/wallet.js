const router = require('express').Router();
const { PKPass } = require('passkit-generator');
const Clientes = require('../models/Clientes');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// ==========================================
// 🔐 CARGA DE CREDENCIALES (MODO SEGURO)
// ==========================================
let SERVICE_ACCOUNT = null;

try {
    if (process.env.GOOGLE_KEY_JSON) {
        console.log("✅ [Wallet] Usando credenciales desde Variable de Entorno (Railway)");
        SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_KEY_JSON);
    } else {
        console.log("⚠️ [Wallet] No hay variable de entorno, buscando archivo local...");
        // Intentamos cargar el archivo solo si existe
        const keyPath = path.join(__dirname, '../keys.json');
        if (fs.existsSync(keyPath)) {
            SERVICE_ACCOUNT = require('../keys.json');
            console.log("✅ [Wallet] Archivo keys.json local cargado.");
        } else {
            console.error("❌ [Wallet] ERROR: No se encontró ni la Variable GOOGLE_KEY_JSON ni el archivo keys.json");
        }
    }
} catch (err) {
    console.error("❌ [Wallet] Error procesando las credenciales:", err.message);
}

// ==========================================
// ⚙️ CONFIGURACIÓN GENERAL
// ==========================================
const BASE_URL = process.env.BASE_URL || 'https://backendfresh-production.up.railway.app';
const WEB_SERVICE_URL = `${BASE_URL}/api/wallet`;
const WALLET_SECRET = process.env.WALLET_SECRET || 'fresh-market-secret-key-2025';

const GOOGLE_ISSUER_ID = '3388000000023046225';
const GOOGLE_CLASS_ID = `${GOOGLE_ISSUER_ID}.fresh_market_loyal`;

function formatSmartName(fullName) {
    if (!fullName) return "Cliente Fresh";
    const words = fullName.trim().split(/\s+/);
    if (words.length <= 2) return fullName;
    let shortName = words[0];
    return shortName + " " + words.slice(1).join(" ");
}

// ==========================================
// 🍏 APPLE WALLET ENDPOINT
// ==========================================
router.get('/apple/:clientId', async (req, res) => {
    // ... (Tu código de Apple se queda igual, no lo toques)
    try {
        const { clientId } = req.params;
        const cliente = await Clientes.findById(clientId);
        if (!cliente) return res.status(404).json({ error: "Cliente no encontrado" });

        const baseDir = path.resolve(__dirname, '../assets/freshmarket');
        const certsDir = path.resolve(__dirname, '../certs');
        const nivelesDir = path.join(baseDir, 'niveles');

        const wwdr = fs.readFileSync(path.join(certsDir, 'wwdr.pem'));
        const signerCert = fs.readFileSync(path.join(certsDir, 'signerCert.pem'));
        const signerKey = fs.readFileSync(path.join(certsDir, 'signerKey.pem'));

        let numSellos = cliente.sellos || 0;
        if (numSellos > 8) numSellos = 8;
        let numPuntos = cliente.puntos || 0;

        let statusText = 'Cliente Fresh';
        if (numSellos >= 8) statusText = '🎁 PREMIO DISPONIBLE ($100)';
        else if (numSellos === 0) statusText = '🌟 BIENVENIDO';

        const stripFilename = `${numSellos}-sello.png`;
        const stripPath = path.join(nivelesDir, stripFilename);
        const finalStripPath = fs.existsSync(stripPath) ? stripPath : path.join(nivelesDir, '0-sello.png');

        const authToken = crypto.createHmac('sha256', WALLET_SECRET)
            .update(cliente._id.toString())
            .digest('hex');

        const buffers = {
            'icon.png': fs.readFileSync(path.join(baseDir, 'icon.png')),
            'icon@2x.png': fs.readFileSync(path.join(baseDir, 'icon.png')),
            'logo.png': fs.readFileSync(path.join(baseDir, 'logo.png')),
            'logo@2x.png': fs.readFileSync(path.join(baseDir, 'logo.png')),
            'strip.png': fs.readFileSync(finalStripPath),
            'strip@2x.png': fs.readFileSync(finalStripPath)
        };

        const nombreLimpio = formatSmartName(cliente.nombre);

        const passJson = {
            formatVersion: 1,
            passTypeIdentifier: "pass.com.freshmarket.pachuca",
            serialNumber: `FRESH-${cliente._id}`,
            teamIdentifier: "L4P8PF94N6",
            organizationName: "Fresh Market",
            description: "Tarjeta de Lealtad",
            logoText: "Fresh Market",
            foregroundColor: "rgb(255, 255, 255)",
            backgroundColor: "rgb(34, 139, 34)",
            labelColor: "rgb(200, 255, 200)",
            webServiceURL: WEB_SERVICE_URL,
            authenticationToken: authToken,
            locations: [{ latitude: 20.102220, longitude: -98.761820, relevantText: "🥕 Fresh Market te espera." }],
            storeCard: {
                headerFields: [{ key: "puntos_header", label: "MIS PUNTOS", value: numPuntos.toString(), textAlignment: "PKTextAlignmentRight" }],
                secondaryFields: [
                    { key: 'balance_sellos', label: 'SELLOS', value: `${numSellos}/8`, textAlignment: "PKTextAlignmentLeft", changeMessage: '¡Nueva actualización! Tienes %@ sellos.' },
                    { key: 'name', label: 'MIEMBRO', value: nombreLimpio, textAlignment: "PKTextAlignmentRight" }
                ],
                auxiliaryFields: [{ key: "status_premio", label: "ESTATUS", value: statusText, textAlignment: "PKTextAlignmentCenter" }],
                backFields: [{ key: 'contact_footer', label: '📞 CONTACTO', value: 'Tel: 7712346620\n© 2025 Fresh Market' }]
            },
            barcode: { format: "PKBarcodeFormatQR", message: cliente._id.toString(), messageEncoding: "iso-8859-1", altText: nombreLimpio }
        };

        const finalBuffers = { ...buffers, 'pass.json': Buffer.from(JSON.stringify(passJson)) };
        const pass = new PKPass(finalBuffers, { wwdr, signerCert, signerKey });
        const buffer = await pass.getAsBuffer();

        res.set('Content-Type', 'application/vnd.apple.pkpass');
        res.set('Content-Disposition', `attachment; filename=fresh-${cliente._id}.pkpass`);
        res.send(buffer);

    } catch (err) {
        console.error("❌ APPLE ERROR:", err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 🤖 GOOGLE WALLET ENDPOINT
// ==========================================
router.get('/google/:clientId', async (req, res) => {
    try {
        // VALIDACIÓN DE SEGURIDAD
        if (!SERVICE_ACCOUNT) {
            return res.status(500).send("Error de configuración: No hay credenciales de Google Wallet.");
        }

        const { clientId } = req.params;
        const cliente = await Clientes.findById(clientId);
        if (!cliente) return res.status(404).send("Cliente no encontrado");

        let numSellos = cliente.sellos || 0;
        if (numSellos > 8) numSellos = 8;

        // URL PÚBLICA DE LA IMAGEN
        const imageName = `${numSellos}-sello.png`;
        const heroImageUrl = `${BASE_URL}/public/freshmarket/niveles/${imageName}`;

        const objectId = `${GOOGLE_ISSUER_ID}.${cliente._id}`;

        const payload = {
            iss: SERVICE_ACCOUNT.client_email,
            aud: 'google',
            typ: 'savetowallet',
            iat: Math.floor(Date.now() / 1000),
            origins: [],
            payload: {
                loyaltyObjects: [{
                    id: objectId,
                    classId: GOOGLE_CLASS_ID,
                    state: 'ACTIVE',
                    accountId: cliente.telefono,
                    version: 1,
                    barcode: {
                        type: 'QR_CODE',
                        value: cliente._id.toString(),
                        alternateText: cliente.telefono
                    },
                    accountName: cliente.nombre,
                    loyaltyPoints: {
                        label: 'Puntos',
                        balance: { string: (cliente.puntos || 0).toString() }
                    },
                    heroImage: {
                        sourceUri: {
                            uri: heroImageUrl
                        }
                    }
                }]
            }
        };

        const token = jwt.sign(payload, SERVICE_ACCOUNT.private_key, { algorithm: 'RS256' });
        const saveUrl = `https://pay.google.com/gp/v/save/${token}`;

        res.redirect(saveUrl);

    } catch (err) {
        console.error("❌ GOOGLE ERROR:", err);
        res.status(500).send('Error interno generando el pase de Google');
    }
});

module.exports = router;