const router = require('express').Router();
const WalletDevice = require('../models/WalletDevice');
const Clientes = require('../models/Clientes');
const MarketingCampaign = require('../models/MarketingCampaign');
// 👇 1. IMPORTACIÓN AGREGADA: Modelo para guardar referencia de Google
const GoogleWalletObject = require('../models/GoogleWalletObject');

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { PKPass } = require('passkit-generator');

// 👇 2. IMPORTACIONES AGREGADAS: Para firma JWT y notificaciones Apple
const jwt = require('jsonwebtoken');
const apn = require('apn');

const { notifyGoogleWalletUpdate } = require('../utils/pushGoogle');
const notifyPassUpdate = require('../utils/pushApple');

// SECRETOS Y CONFIGURACIÓN
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
        // En Railway tomará esto
        SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_KEY_JSON);
    } else {
        const keyPath = path.join(__dirname, '../keys.json');
        if (fs.existsSync(keyPath)) SERVICE_ACCOUNT = require('../keys.json');
    }
} catch (err) { console.error("❌ Error credenciales Google:", err.message); }

// ==========================================
// 🧠 HELPER: FORMATEO DE NOMBRE
// ==========================================
function formatSmartName(fullName) {
    if (!fullName) return "Cliente Fresh";
    let cleanName = fullName.split('-')[0].trim();
    cleanName = cleanName.replace(/\s+/g, ' ');
    const words = cleanName.split(' ');
    if (words.length <= 2) return cleanName;
    const connectors = ['de', 'del', 'la', 'las', 'los', 'y', 'san', 'santa', 'van', 'von'];
    let resultName = words[0];
    let i = 1;
    while (i < words.length) {
        const word = words[i];
        resultName += " " + word;
        if (!connectors.includes(word.toLowerCase())) break;
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
// RUTAS APPLE (REGISTRO, LOG, ETC)
// ==========================================

// 1. REGISTRO (APPLE)
router.post('/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber', async (req, res) => {
    try {
        const { deviceId, passTypeId, serialNumber } = req.params;
        const { pushToken } = req.body;
        if (!validateAuthToken(req.headers.authorization, serialNumber)) return res.sendStatus(401);

        await WalletDevice.findOneAndUpdate(
            { deviceLibraryIdentifier: deviceId, serialNumber: serialNumber },
            { pushToken: pushToken, passTypeIdentifier: passTypeId },
            { upsert: true, new: true }
        );
        const clientId = serialNumber.replace('FRESH-', '');
        await Clientes.findByIdAndUpdate(clientId, { hasWallet: true, walletPlatform: 'apple' });
        res.sendStatus(201);
    } catch (err) { console.error(err); res.sendStatus(500); }
});

// 2. CONSULTA (APPLE)
router.get('/v1/devices/:deviceId/registrations/:passTypeId', async (req, res) => {
    try {
        const { deviceId, passTypeId } = req.params;
        const registrations = await WalletDevice.find({ deviceLibraryIdentifier: deviceId, passTypeIdentifier: passTypeId });
        if (registrations.length === 0) return res.sendStatus(204);
        const serials = registrations.map(reg => reg.serialNumber);
        res.json({ lastUpdated: new Date().toISOString(), serialNumbers: serials });
    } catch (err) { console.error(err); res.sendStatus(500); }
});

// ==========================================
// ⚡️ FUNCIÓN GENERADORA DEL PASE APPLE
// ==========================================
async function generateApplePass(clientId, res, isDownload = false) {
    const cliente = await Clientes.findById(clientId);
    if (!cliente) return res.status(404).send("Cliente no encontrado");

    // --- DATOS CAMPAÑA ---
    let promoTitle = "📢 NOVEDADES";
    let promoMessage = "🥕 ¡Bienvenido a Fresh Market!";
    try {
        // 👇 CAMBIO AQUÍ: Agregamos { isTest: { $ne: true } }
        // Esto significa: Trae la última, PERO que NO sea de prueba.
        const lastCampaign = await MarketingCampaign.findOne({ isTest: { $ne: true } }).sort({ sentAt: -1 });

        if (lastCampaign) {
            promoTitle = "📢 " + (lastCampaign.title || "NOVEDADES");
            promoMessage = lastCampaign.message;
        }
    } catch (e) { }

    const baseDir = path.resolve(__dirname, '../assets/freshmarket');
    const certsDir = path.resolve(__dirname, '../certs');
    const nivelesDir = path.join(baseDir, 'niveles');

    const wwdr = fs.readFileSync(path.join(certsDir, 'wwdr.pem'));
    const signerCert = fs.readFileSync(path.join(certsDir, 'signerCert.pem'));
    const signerKey = fs.readFileSync(path.join(certsDir, 'signerKey.pem'));

    // --- LÓGICA DE NIVELES ---
    const totalGastado = cliente.totalGastado || 0;
    let nivelNombre = 'Nivel Bronce';
    let nivelEmoji = '🥉';

    let appleBackgroundColor = "rgb(34, 139, 34)"; // Verde
    let appleLabelColor = "rgb(200, 255, 200)";

    if (totalGastado >= 15000) {
        nivelNombre = 'Nivel Oro';
        nivelEmoji = '🏆';
        appleBackgroundColor = "rgb(218, 165, 32)";
        appleLabelColor = "rgb(255, 250, 200)";
    } else if (totalGastado >= 5000) {
        nivelNombre = 'Nivel Plata';
        nivelEmoji = '🥈';
        appleBackgroundColor = "rgb(169, 169, 169)";
        appleLabelColor = "rgb(240, 240, 240)";
    }

    // --- LÓGICA DE SELLOS ---
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
        locations: [{ latitude: 20.0979892, longitude: -98.7709978, relevantText: "🥕 No olvides hacer tu pedido Fresh Market esta semana. 👋" }],
        storeCard: {
            headerFields: [
                { key: "header_puntos", label: "Puntos", value: `${numPuntos} pts`, textAlignment: "PKTextAlignmentRight", changeMessage: "Tus puntos cambiaron a %@" }
            ],
            secondaryFields: [
                { key: "balance_sellos", label: "MIS SELLOS", value: `${sellosVisuales} de 8`, textAlignment: "PKTextAlignmentLeft", changeMessage: "¡Actualización! Ahora tienes %@ sellos 🥕" },
                { key: 'nivel_info', label: 'TITULAR', value: `${nombreLimpio}`, textAlignment: "PKTextAlignmentRight" }
            ],
            auxiliaryFields: [
                { key: "status", label: "ESTATUS", value: statusText, textAlignment: "PKTextAlignmentCenter" }
            ],
            backFields: [
                { key: "marketing_promo", label: promoTitle, value: promoMessage, textAlignment: "PKTextAlignmentLeft", changeMessage: "%@" },
                { key: "account_info", label: "👤 TITULAR", value: `${nombreLimpio}`, textAlignment: "PKTextAlignmentRight" },
                { key: "quick_links", label: "📱 CONTACTO RÁPIDO", value: "WhatsApp: 7712346620", textAlignment: "PKTextAlignmentLeft" },
                { key: 'redes_sociales', label: '🌐 SÍGUENOS', value: 'Instagram: https://www.instagram.com/fresh_marketp\nFacebook: https://www.facebook.com/freshmarketp\nWhatsApp: https://wa.me/7712346620', textAlignment: "PKTextAlignmentLeft" },
                { key: "how_it_works", label: "🙌 TU TARJETA FRESH", value: "🥕 Recibe por semana 1 sello por compras mayores a $285.\n🎉 Al juntar 8 sellos, ¡recibe un producto con valor de $100!\n💰 Tus puntos valen dinero electrónico.", textAlignment: "PKTextAlignmentLeft" },
                { key: "last_update", label: "⏰ Última Actualización", value: new Date().toLocaleString('es-MX', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }), textAlignment: "PKTextAlignmentRight" }
            ]
        },
        barcodes: [{ format: "PKBarcodeFormatQR", message: cliente._id.toString(), messageEncoding: "iso-8859-1", altText: 'fidelify.mx' }]
    };

    const finalBuffers = { ...buffers, 'pass.json': Buffer.from(JSON.stringify(passJson)) };
    const pass = new PKPass(finalBuffers, { wwdr, signerCert, signerKey });
    const buffer = await pass.getAsBuffer();

    res.set('Content-Type', 'application/vnd.apple.pkpass');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    if (isDownload) {
        res.set('Content-Disposition', `attachment; filename=fresh-${cliente._id}.pkpass`);
    }
    res.send(buffer);
}

// 3. ENTREGA DEL PASE (Endpoint Interno Apple)
router.get('/v1/passes/:passTypeId/:serialNumber', async (req, res) => {
    try {
        const { serialNumber } = req.params;
        if (!validateAuthToken(req.headers.authorization, serialNumber)) return res.sendStatus(401);
        const clientId = serialNumber.replace('FRESH-', '');
        await generateApplePass(clientId, res, false);
    } catch (err) { res.status(500).send("Error generando pase"); }
});

// 4. 📥 DESCARGA DIRECTA (APPLE)
router.get('/download/apple/:clientId', async (req, res) => {
    try {
        let { clientId } = req.params;
        clientId = cleanObjectId(clientId);
        await generateApplePass(clientId, res, true);
    } catch (err) { res.status(500).send("Error descargando pase"); }
});

// 5. 🤖 GOOGLE WALLET ENDPOINT
router.get('/google/:clientId', async (req, res) => {
    try {
        // Validación de credenciales
        if (!SERVICE_ACCOUNT) return res.status(500).send("No credentials configured (SERVICE_ACCOUNT missing)");

        let { clientId } = req.params;
        clientId = cleanObjectId(clientId);
        const cliente = await Clientes.findById(clientId);
        if (!cliente) return res.status(404).send("Cliente no encontrado");

        // --- LÓGICA DE NIVELES GOOGLE ---
        const totalGastado = cliente.totalGastado || 0;
        let nivelNombre = 'Nivel Bronce';
        let nivelEmoji = '🥉';
        let selectedClassId = CLASS_NORMAL;

        if (totalGastado >= 15000) {
            nivelNombre = 'Nivel Oro';
            nivelEmoji = '🏆';
            selectedClassId = CLASS_LEGEND;
        } else if (totalGastado >= 5000) {
            nivelNombre = 'Nivel Plata';
            nivelEmoji = '🥈';
            selectedClassId = CLASS_NORMAL;
        }

        let numSellos = cliente.sellos || 0;
        const sellosVisuales = (numSellos > 0 && numSellos % 8 === 0) ? 8 : numSellos % 8;
        const imageName = `${sellosVisuales}-sello.png`;
        const heroImageUrl = `${BASE_URL}/public/freshmarket/niveles/${imageName}`;

        const objectId = `${GOOGLE_ISSUER_ID}.${cliente._id}`;
        const nombreLimpio = formatSmartName(cliente.nombre);

        // 👇 TRUCO VISUAL (LeDuo Style) para la portada
        // Esto asegura que desde que lo bajan se vea "3/8 sellos" y no el nombre
        const textoPortada = numSellos >= 8
            ? "🎁 ¡Premio disponible!"
            : `${sellosVisuales}/8 sellos • ${(cliente.puntos || 0).toFixed(0)} pts`;

        // --- GESTIÓN DE VERSIÓN Y BD ---
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

        // --- CONSTRUCCIÓN DEL JWT PAYLOAD ---
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
                    accountId: cliente._id,
                    version: version,
                    // 👇 1. IMPORTANTE: Activar notificaciones desde el inicio
                    notifyPreference: "notifyOnUpdate",
                    barcode: {
                        type: 'QR_CODE',
                        value: cliente._id.toString(),
                        alternateText: "Fidelify.mx"
                    },
                    // 👇 2. IMPORTANTE: Usar el texto dinámico en la portada
                    accountName: textoPortada,
                    loyaltyPoints: {
                        label: 'Puntos',
                        balance: { string: (cliente.puntos || 0).toString() }
                    },
                    secondaryLoyaltyPoints: {
                        label: 'Mis Sellos',
                        balance: { string: `${sellosVisuales} de 8` }
                    },
                    accountHolderName: `${nivelEmoji} ${nivelNombre}`,
                    heroImage: {
                        sourceUri: { uri: heroImageUrl }
                    },
                    linksModuleData: {
                        uris: [
                            { kind: "i18n.WALLET_URI_PHONE", uri: "tel:7712346620", description: "Llamar" },
                            { kind: "i18n.WALLET_URI_WEB", uri: "https://wa.me/527712346620", description: "WhatsApp" }
                        ]
                    },
                    textModulesData: [
                        // 👇 3. IMPORTANTE: Mover el nombre real aquí
                        { header: "Titular", body: nombreLimpio, id: "account_holder" },
                        { header: 'Nivel actual', body: `${nivelNombre}`, id: "status_module" },
                        { header: "Novedades", body: "🥕 ¡Sigue acumulando puntos y sellos!", id: "news_module" }
                    ]
                }]
            }
        };

        // --- FIRMA DEL TOKEN ---
        const token = jwt.sign(payload, SERVICE_ACCOUNT.private_key, { algorithm: 'RS256' });
        const saveUrl = `https://pay.google.com/gp/v/save/${token}`;

        await Clientes.findByIdAndUpdate(clientId, { hasWallet: true, walletPlatform: 'google' });

        // Redirigir a Google Pay
        res.redirect(saveUrl);

    } catch (err) {
        console.error("❌ GOOGLE ERROR:", err);
        res.status(500).send(`Error Google: ${err.message}`);
    }
});

// 6. BAJA
router.delete('/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber', async (req, res) => {
    try {
        const { deviceId, serialNumber } = req.params;
        if (!validateAuthToken(req.headers.authorization, serialNumber)) return res.sendStatus(401);
        await WalletDevice.findOneAndDelete({ deviceLibraryIdentifier: deviceId, serialNumber: serialNumber });
        res.sendStatus(200);
    } catch (err) { console.error(err); res.sendStatus(500); }
});

// 7. REDIRECTOR INTELIGENTE
router.get('/go/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;
        const cleanId = cleanObjectId(clientId);
        const userAgent = req.headers['user-agent'] || '';

        // CORRECCIÓN: Quitamos !window.MSStream porque 'window' no existe en Node.js
        const isIOS = /iPad|iPhone|iPod/.test(userAgent);

        if (isIOS) {
            res.redirect(`${WEB_SERVICE_URL}/v1/passes/pass.com.freshmarket.pachuca/FRESH-${cleanId}`);
        } else {
            res.redirect(`${WEB_SERVICE_URL}/google/${cleanId}`);
        }
    } catch (err) { res.status(500).send("Error redirigiendo"); }
});

// ==========================================
// 🚀 8. NOTIFICACIONES PUSH MASIVAS (Apple + Google Update)
// ==========================================
router.post('/notify-bulk', async (req, res) => {
    const { clientIds } = req.body;

    if (!clientIds || clientIds.length === 0) {
        return res.json({ summary: { success: 0, failed: 0 } });
    }

    let successCount = 0;
    let failCount = 0;

    // Configuración APN (Apple)
    let apnProvider;
    try {
        const certPath = path.join(__dirname, '../certs/signerCert.pem');
        const keyPath = path.join(__dirname, '../certs/signerKey.pem');
        if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
            apnProvider = new apn.Provider({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), production: true });
        }
    } catch (e) { console.error("⚠️ Error APN:", e.message); }

    for (const clientId of clientIds) {
        try {
            const cliente = await Clientes.findById(clientId);
            if (!cliente || !cliente.hasWallet) continue;

            // --- LÓGICA APPLE 🍏 (Igual que antes) ---
            if (cliente.walletPlatform === 'apple' || cliente.walletPlatform === 'both') {
                const devices = await WalletDevice.find({ serialNumber: `FRESH-${cliente._id}` });
                if (devices.length > 0 && apnProvider) {
                    const notification = new apn.Notification();
                    notification.payload = {};
                    for (const device of devices) {
                        try {
                            await apnProvider.send(notification, device.pushToken);
                            successCount++;
                        } catch (err) { console.error(`Error Apple:`, err); }
                    }
                }
            }

            // --- LÓGICA GOOGLE 🤖 (TOTALMENTE NUEVA Y REAL) ---
            if (cliente.walletPlatform === 'google' || cliente.walletPlatform === 'both') {
                try {
                    // 👇 2. CORREGIDO: Llamamos a tu script que hace la magia (PATCH + SLEEP + ADD MESSAGE)
                    // Antes solo guardabas en DB, por eso no llegaban.
                    console.log(`🤖 Iniciando notificación Google para ${clientId}...`);

                    await notifyGoogleWalletUpdate(clientId);

                    successCount++;
                } catch (err) {
                    console.error("Error notificando Google:", err);
                    failCount++;
                }
            }

        } catch (error) {
            failCount++;
            console.error(`Error notificando cliente ${clientId}:`, error);
        }
    }

    if (apnProvider) apnProvider.shutdown();

    res.json({
        success: true,
        summary: {
            success: successCount,
            failed: failCount,
            total: clientIds.length
        }
    });
});


// ==========================================
// 🧪 LINK DE PRUEBA UNITARIA (Flexible)
// Uso simple: .../test-push/ID_CLIENTE (Usa último msj de BD)
// Uso custom: .../test-push/ID_CLIENTE?title=Hola&message=Probando (Usa tu texto)
// ==========================================
router.get('/test-push/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;
        const cleanId = clientId.trim();
        const { title, message } = req.query;

        // 1. Buscar Cliente
        const cliente = await Clientes.findById(cleanId);
        if (!cliente) return res.status(404).send("Cliente no encontrado en BD");

        console.log(`🧪 TEST-PUSH para: ${cliente.nombre}`);

        // 2. Datos Custom
        let customData = null;
        if (title && message) {
            customData = { title, message };
            // 🔥 TRUCO APPLE
            if (cliente.walletPlatform === 'apple' || cliente.walletPlatform === 'both') {
                 await MarketingCampaign.create({
                    title: title,
                    message: message,
                    sentAt: new Date(),
                    isTest: true // 👈 AGREGAMOS ESTA BANDERA
                });
                console.log("🍏 Apple: Campaña TEST guardada en BD");
            }
        }

        let log = [];

        // -----------------------------------------------------
        // 🤖 INTENTO GOOGLE (Forzado)
        // -----------------------------------------------------
        try {
            await notifyGoogleWalletUpdate(cleanId, customData);
            log.push("✅ Google: Orden enviada");
        } catch (e) {
            log.push(`❌ Google Error: ${e.message}`);
        }

        // -----------------------------------------------------
        // 🍏 INTENTO APPLE (Verificando dispositivos)
        // -----------------------------------------------------
        const devices = await WalletDevice.find({ serialNumber: `FRESH-${cleanId}` });

        if (devices.length > 0) {
            try {
                // Notificamos a Apple. El iPhone pedirá el pase nuevo -> Leerá la Campaña de BD -> Mostrará notificación.
                await notifyPassUpdate(cleanId);
                log.push(`✅ Apple: Enviado a ${devices.length} dispositivo(s)`);
            } catch (e) {
                log.push(`❌ Apple Error: ${e.message}`);
            }
        } else {
            log.push(`⚠️ Apple: No se enviará (0 dispositivos encontrados).`);
        }

        // Respuesta Visual
        res.send(`
            <div style="font-family: sans-serif; padding: 20px;">
                <h1 style="color: #007bff;">Diagnóstico de Notificación</h1>
                <p><strong>Cliente:</strong> ${cliente.nombre}</p>
                <p><strong>Plataforma BD:</strong> ${cliente.walletPlatform}</p>
                <hr>
                <h3>Resultados:</h3>
                <ul>${log.map(l => `<li>${l}</li>`).join('')}</ul>
                <button onclick="window.history.back()" style="padding:10px; cursor:pointer; margin-top:20px;">⬅ Volver</button>
            </div>
        `);

    } catch (err) {
        console.error("❌ Error Fatal en Prueba:", err);
        res.status(500).send(`Error Fatal: ${err.message}`);
    }
});

// ==========================================
// 🕵️‍♂️ 9. AUDITORÍA DE WALLETS
// ==========================================
router.get('/debug/audit', async (req, res) => {
    try {
        const appleDevices = await WalletDevice.find({});
        const uniqueAppleClients = new Set(appleDevices.map(d => d.serialNumber));
        const googleObjects = await GoogleWalletObject.find({});

        const clientsWithFlag = await Clientes.find({
            $or: [
                { hasWallet: true },
                { walletPlatform: { $in: ['apple', 'google', 'both'] } }
            ]
        });

        const totalRealWalletIds = [];
        appleDevices.forEach(d => {
            const id = d.serialNumber.replace('FRESH-', '');
            totalRealWalletIds.push(id);
        });
        googleObjects.forEach(g => {
            if (g.clienteId) totalRealWalletIds.push(g.clienteId.toString());
        });

        const notFlagged = await Clientes.find({
            _id: { $in: totalRealWalletIds },
            hasWallet: { $ne: true }
        });

        res.json({
            resumen: {
                real_apple_devices: appleDevices.length,
                real_unique_apple_users: uniqueAppleClients.size,
                real_google_users: googleObjects.length,
                total_real_wallets: uniqueAppleClients.size + googleObjects.length,
                clients_table_flagged: clientsWithFlag.length,
                DESINCRONIZADOS: {
                    mensaje: "Usuarios que tienen wallet en BD pero no aparecen en la lista de clientes",
                    cantidad: notFlagged.length,
                    nombres: notFlagged.map(c => c.nombre)
                }
            }
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;