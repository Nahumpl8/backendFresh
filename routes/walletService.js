const router = require('express').Router();
const WalletDevice = require('../models/WalletDevice');
const Clientes = require('../models/Clientes');
const MarketingCampaign = require('../models/MarketingCampaign');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { PKPass } = require('passkit-generator');

// SECRETOS
const WALLET_SECRET = process.env.WALLET_SECRET || 'fresh-market-secret-key-2025';
const BASE_URL = process.env.BASE_URL || 'https://backendfresh-production.up.railway.app';
const WEB_SERVICE_URL = `${BASE_URL}/api/wallet`;

// CONFIGURACIÓN GOOGLE
const GOOGLE_ISSUER_ID = '3388000000023046225';
const CLASS_NORMAL = `${GOOGLE_ISSUER_ID}.fresh_market_loyal`;
const CLASS_LEGEND = `${GOOGLE_ISSUER_ID}.fresh_market_legend`;

// 🔐 CREDENCIALES GOOGLE
let SERVICE_ACCOUNT = null;
try {
    if (process.env.GOOGLE_KEY_JSON) {
        SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_KEY_JSON);
    } else {
        const keyPath = path.join(__dirname, '../keys.json');
        if (fs.existsSync(keyPath)) SERVICE_ACCOUNT = require('../keys.json');
    }
} catch (err) { console.error("❌ Error credenciales Google:", err.message); }

// ==========================================
// 🧠 FORMATEO DE NOMBRE INTELIGENTE
// ==========================================
function formatSmartName(fullName) {
    if (!fullName) return "Cliente Fresh";

    // 1. Quitar la dirección (todo lo que esté después de un guión "-")
    let cleanName = fullName.split('-')[0].trim();
    // 2. Normalizar espacios
    cleanName = cleanName.replace(/\s+/g, ' ');

    const words = cleanName.split(' ');
    if (words.length <= 2) return cleanName;

    // 3. Lógica para apellidos compuestos
    const connectors = ['de', 'del', 'la', 'las', 'los', 'y', 'san', 'santa', 'van', 'von', 'da', 'di'];
    
    let resultName = words[0]; // Primer nombre
    let i = 1;
    while(i < words.length) {
        const word = words[i];
        resultName += " " + word;
        if (!connectors.includes(word.toLowerCase())) {
            break; 
        }
        i++;
    }
    return resultName;
}

function validateAuthToken(authHeader, serialNumber) {
    if (!authHeader) return false;
    const token = authHeader.replace('ApplePass ', '');
    const clientId = serialNumber.replace('FRESH-', '');
    const expectedToken = crypto.createHmac('sha256', WALLET_SECRET).update(clientId).digest('hex');
    return token === expectedToken;
}

function cleanObjectId(id) {
    if (!id) return "";
    return id.trim().replace(/[^a-fA-F0-9]/g, "");
}

// ==========================================
// 1. REGISTRO (APPLE INTERNO)
// ==========================================
router.post('/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber', async (req, res) => {
    try {
        const { deviceId, passTypeId, serialNumber } = req.params;
        const { pushToken } = req.body;
        console.log(`📲 Registro Apple Wallet recibido: ${serialNumber}`);

        if (!validateAuthToken(req.headers.authorization, serialNumber)) return res.sendStatus(401);

        await WalletDevice.findOneAndUpdate(
            { deviceLibraryIdentifier: deviceId, serialNumber: serialNumber },
            { pushToken: pushToken, passTypeIdentifier: passTypeId },
            { upsert: true, new: true }
        );

        const clientId = serialNumber.replace('FRESH-', '');
        await Clientes.findByIdAndUpdate(clientId, { hasWallet: true, walletPlatform: 'apple' });

        res.sendStatus(201);
    } catch (err) {
        console.error("❌ Error registrando:", err);
        res.sendStatus(500);
    }
});

// ==========================================
// 2. CONSULTA (APPLE INTERNO)
// ==========================================
router.get('/v1/devices/:deviceId/registrations/:passTypeId', async (req, res) => {
    try {
        const { deviceId, passTypeId } = req.params;
        const registrations = await WalletDevice.find({ deviceLibraryIdentifier: deviceId, passTypeIdentifier: passTypeId });
        if (registrations.length === 0) return res.sendStatus(204); 

        const serials = registrations.map(reg => reg.serialNumber);
        res.json({ lastUpdated: new Date().toISOString(), serialNumbers: serials });
    } catch (err) { res.sendStatus(500); }
});

// ==========================================
// 3. ENTREGA DEL PASE (APPLE UPDATE AUTOMÁTICO)
// ==========================================
router.get('/v1/passes/:passTypeId/:serialNumber', async (req, res) => {
    try {
        const { serialNumber } = req.params;
        if (!validateAuthToken(req.headers.authorization, serialNumber)) return res.sendStatus(401);

        const clientId = serialNumber.replace('FRESH-', '');
        await serveApplePass(clientId, res); // Reutilizamos lógica
    } catch (err) {
        console.error("❌ APPLE ERROR:", err);
        res.status(500).send("Error generando pase");
    }
});

// ==========================================
// 📥 4. DESCARGA DIRECTA APPLE (BOTÓN WEB)
// ==========================================
router.get('/download/apple/:clientId', async (req, res) => {
    try {
        let { clientId } = req.params;
        clientId = cleanObjectId(clientId);
        await serveApplePass(clientId, res);
    } catch (err) {
        console.error("❌ DOWNLOAD ERROR:", err);
        res.status(500).send("Error descargando pase");
    }
});

// --- FUNCIÓN HELPER PARA GENERAR EL PASE APPLE ---
async function serveApplePass(clientId, res) {
    const cliente = await Clientes.findById(clientId);
    if (!cliente) return res.status(404).send("Cliente no encontrado");

    // --- DATOS CAMPAÑA ---
    let promoTitle = "📢 NOVEDADES";
    let promoMessage = "🥕 ¡Bienvenido a Fresh Market!";
    try {
        const lastCampaign = await MarketingCampaign.findOne().sort({ sentAt: -1 });
        if (lastCampaign) {
            promoTitle = "📢 " + (lastCampaign.title || "NOVEDADES");
            promoMessage = lastCampaign.message;
        }
    } catch (e) {}

    const baseDir = path.resolve(__dirname, '../assets/freshmarket');
    const certsDir = path.resolve(__dirname, '../certs');
    const nivelesDir = path.join(baseDir, 'niveles');

    const wwdr = fs.readFileSync(path.join(certsDir, 'wwdr.pem'));
    const signerCert = fs.readFileSync(path.join(certsDir, 'signerCert.pem'));
    const signerKey = fs.readFileSync(path.join(certsDir, 'signerKey.pem'));

    // LÓGICA DE NIVELES (DINERO)
    const totalGastado = cliente.totalGastado || 0;
    let nivelNombre = 'Nivel Bronce';
    let nivelEmoji = '🥉';
    let appleBackgroundColor = "rgb(34, 139, 34)"; 
    let appleLabelColor = "rgb(200, 255, 200)";

    if (totalGastado >= 15000) { 
        nivelNombre = 'Nivel Oro'; nivelEmoji = '🏆';
        appleBackgroundColor = "rgb(218, 165, 32)"; appleLabelColor = "rgb(255, 250, 200)";
    } else if (totalGastado >= 5000) {
        nivelNombre = 'Nivel Plata'; nivelEmoji = '🥈';
        appleBackgroundColor = "rgb(128, 128, 128)"; appleLabelColor = "rgb(240, 240, 240)";
    }

    // LÓGICA DE SELLOS
    let numSellos = cliente.sellos || 0;
    let numPuntos = cliente.puntos || 0;
    let statusText = `${nivelEmoji} ${nivelNombre}`;
    if (numSellos > 0 && numSellos % 8 === 0) statusText = '🎁 ¡PREMIO DISPONIBLE!';

    const sellosVisuales = (numSellos > 0 && numSellos % 8 === 0) ? 8 : numSellos % 8;
    const stripFilename = `${sellosVisuales}-sello.png`;
    const stripPath = path.join(nivelesDir, stripFilename);
    const finalStripPath = fs.existsSync(stripPath) ? stripPath : path.join(nivelesDir, '0-sello.png');

    const authToken = crypto.createHmac('sha256', WALLET_SECRET).update(cliente._id.toString()).digest('hex');
    const nombreLimpio = formatSmartName(cliente.nombre);

    const buffers = {
        'icon.png': fs.readFileSync(path.join(baseDir, 'icon.png')),
        'icon@2x.png': fs.readFileSync(path.join(baseDir, 'icon.png')),
        'logo.png': fs.readFileSync(path.join(baseDir, 'logo.png')),
        'logo@2x.png': fs.readFileSync(path.join(baseDir, 'logo.png')),
        'strip.png': fs.readFileSync(finalStripPath),
        'strip@2x.png': fs.readFileSync(finalStripPath)
    };

    const passJson = {
        formatVersion: 1,
        passTypeIdentifier: "pass.com.freshmarket.pachuca",
        serialNumber: `FRESH-${cliente._id}`,
        teamIdentifier: "L4P8PF94N6",
        organizationName: "Fresh Market",
        description: "Tarjeta de Lealtad",
        logoText: "Fresh Market",
        foregroundColor: "rgb(255, 255, 255)",
        backgroundColor: appleBackgroundColor,
        labelColor: appleLabelColor,
        webServiceURL: WEB_SERVICE_URL,
        authenticationToken: authToken,
        userInfo: { generatedAt: new Date().toISOString(), forceUpdate: Math.random().toString() },
        locations: [{ latitude: 20.102220, longitude: -98.761820, relevantText: "🥕 Fresh Market te espera." }],
        storeCard: {
            headerFields: [{ key: "header_puntos", label: "Puntos", value: `${numPuntos} pts`, textAlignment: "PKTextAlignmentRight", changeMessage: "Tus puntos cambiaron a %@" }],
            secondaryFields: [
                { key: "balance_sellos", label: "MIS SELLOS", value: `${sellosVisuales} de 8`, textAlignment: "PKTextAlignmentLeft", changeMessage: "¡Actualización! Ahora tienes %@ sellos 🥕" },
                { key: 'nivel_info', label: 'TU NIVEL', value: `${nivelEmoji} ${nivelNombre}`, textAlignment: "PKTextAlignmentRight" }
            ],
            auxiliaryFields: [{ key: "status", label: "ESTATUS", value: statusText, textAlignment: "PKTextAlignmentCenter" }],
            backFields: [
                { key: "marketing_promo", label: promoTitle, value: promoMessage, textAlignment: "PKTextAlignmentLeft", changeMessage: "%@" },
                { key: "account_info", label: "👤 TITULAR", value: `${nombreLimpio}\n${nivelNombre}\nGasto: $${totalGastado.toLocaleString('es-MX')}`, textAlignment: "PKTextAlignmentRight" },
                { key: "quick_links", label: "📱 CONTACTO", value: "WhatsApp: 7712346620", textAlignment: "PKTextAlignmentLeft" }
            ]
        },
        barcodes: [{ format: "PKBarcodeFormatQR", message: cliente._id.toString(), messageEncoding: "iso-8859-1", altText: 'fidelify.mx' }]
    };

    const finalBuffers = { ...buffers, 'pass.json': Buffer.from(JSON.stringify(passJson)) };
    const pass = new PKPass(finalBuffers, { wwdr, signerCert, signerKey });
    const buffer = await pass.getAsBuffer();

    res.set('Content-Type', 'application/vnd.apple.pkpass');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Content-Disposition', `attachment; filename=fresh-${cliente._id}.pkpass`);
    res.send(buffer);
}

// ==========================================
// 5. GOOGLE WALLET ENDPOINT
// ==========================================
router.get('/google/:clientId', async (req, res) => {
    try {
        if (!SERVICE_ACCOUNT) return res.status(500).send("No credentials");

        let { clientId } = req.params;
        clientId = cleanObjectId(clientId);
        
        if (!mongoose.Types.ObjectId.isValid(clientId)) return res.status(400).send("ID inválido.");

        const cliente = await Clientes.findById(clientId);
        if (!cliente) return res.status(404).send("Cliente no encontrado");

        // 1. NIVELES
        const totalGastado = cliente.totalGastado || 0;
        let nivelNombre = 'Nivel Bronce';
        let nivelEmoji = '🥉';
        let selectedClassId = CLASS_NORMAL;

        if (totalGastado >= 15000) {
            nivelNombre = 'Nivel Oro'; nivelEmoji = '🏆'; selectedClassId = CLASS_LEGEND; 
        } else if (totalGastado >= 5000) {
            nivelNombre = 'Nivel Plata'; nivelEmoji = '🥈'; selectedClassId = CLASS_NORMAL; 
        }

        // 2. SELLOS
        let numSellos = cliente.sellos || 0;
        const sellosVisuales = (numSellos > 0 && numSellos % 8 === 0) ? 8 : numSellos % 8;
        const imageName = `${sellosVisuales}-sello.png`;
        const heroImageUrl = `${BASE_URL}/public/freshmarket/niveles/${imageName}`;

        const objectId = `${GOOGLE_ISSUER_ID}.${cliente._id}`;
        const nombreLimpio = formatSmartName(cliente.nombre);

        let walletObject = await GoogleWalletObject.findOne({ objectId });
        let version = 1;

        if (walletObject) {
            version = walletObject.version + 1;
            if (walletObject.classId !== selectedClassId) {
                await GoogleWalletObject.updateOne({ objectId }, { classId: selectedClassId, version, updatedAt: new Date() });
            } else {
                await GoogleWalletObject.updateOne({ objectId }, { version, updatedAt: new Date() });
            }
        } else {
            walletObject = await GoogleWalletObject.create({ objectId, clienteId: cliente._id, classId: selectedClassId, version: 1 });
        }

        const payload = {
            iss: SERVICE_ACCOUNT.client_email,
            aud: 'google',
            typ: 'savetowallet',
            iat: Math.floor(Date.now() / 1000),
            origins: [],
            payload: {
                loyaltyObjects: [{
                    id: objectId,
                    classId: selectedClassId,
                    state: 'ACTIVE',
                    accountId: cliente.telefono,
                    version: version,
                    barcode: { type: 'QR_CODE', value: cliente._id.toString(), alternateText: "Fidelify.mx" },
                    accountName: nombreLimpio,
                    loyaltyPoints: { label: 'Puntos', balance: { string: (cliente.puntos || 0).toString() } },
                    secondaryLoyaltyPoints: { label: 'Mis Sellos', balance: { string: `${sellosVisuales} de 8` } },
                    accountHolderName: `${nivelEmoji} ${nivelNombre}`,
                    heroImage: { sourceUri: { uri: heroImageUrl } },
                    linksModuleData: {
                        uris: [
                            { kind: "i18n.WALLET_URI_PHONE", uri: "tel:7712346620", description: "Llamar" },
                            { kind: "i18n.WALLET_URI_WEB", uri: "https://wa.me/527712346620", description: "WhatsApp" }
                        ]
                    },
                    textModulesData: [
                        { header: "Estatus VIP", body: `${nivelNombre} (Gasto: $${totalGastado.toLocaleString('es-MX')})`, id: "status_module" },
                        { header: "Novedades", body: "🥕 ¡Sigue acumulando para ganar premios!", id: "news_module" }
                    ]
                }]
            }
        };

        const token = jwt.sign(payload, SERVICE_ACCOUNT.private_key, { algorithm: 'RS256' });
        const saveUrl = `https://pay.google.com/gp/v/save/${token}`;

        await Clientes.findByIdAndUpdate(clientId, { hasWallet: true, walletPlatform: 'google' });
        res.redirect(saveUrl);

    } catch (err) {
        console.error("❌ GOOGLE ERROR:", err);
        res.status(500).send('Error interno Google');
    }
});

// 6. BAJA
router.delete('/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber', async (req, res) => {
    try {
        const { deviceId, serialNumber } = req.params;
        if (!validateAuthToken(req.headers.authorization, serialNumber)) return res.sendStatus(401);
        await WalletDevice.findOneAndDelete({ deviceLibraryIdentifier: deviceId, serialNumber: serialNumber });
        res.sendStatus(200);
    } catch (err) { res.sendStatus(500); }
});

// 7. REDIRECTOR INTELIGENTE
router.get('/go/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;
        const cleanId = cleanObjectId(clientId);
        const userAgent = req.headers['user-agent'] || '';
        const isIOS = /iPad|iPhone|iPod/.test(userAgent) && !window.MSStream;

        if (isIOS) {
            // Si es iPhone, usamos el servicio interno de pase
            res.redirect(`${WEB_SERVICE_URL}/v1/passes/pass.com.freshmarket.pachuca/FRESH-${cleanId}`);
        } else {
            // Si no, asumimos Android
            res.redirect(`${WEB_SERVICE_URL}/google/${cleanId}`);
        }
    } catch (err) { res.status(500).send("Error redirigiendo"); }
});

module.exports = router;