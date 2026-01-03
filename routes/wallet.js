const router = require('express').Router();
const { PKPass } = require('passkit-generator');
const Clientes = require('../models/Clientes');
const GoogleWalletObject = require('../models/GoogleWalletObject');
const notifyPassUpdate = require('../utils/pushApple');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose'); 

// ==========================================
// 🔐 CARGA DE CREDENCIALES
// ==========================================
let SERVICE_ACCOUNT = null;
try {
    if (process.env.GOOGLE_KEY_JSON) {
        console.log("✅ [Wallet] Usando credenciales (Railway)");
        SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_KEY_JSON);
    } else {
        const keyPath = path.join(__dirname, '../keys.json');
        if (fs.existsSync(keyPath)) {
            SERVICE_ACCOUNT = require('../keys.json');
            console.log("✅ [Wallet] Usando keys.json local.");
        }
    }
} catch (err) { console.error("❌ Error credenciales:", err.message); }

// ==========================================
// ⚙️ CONFIGURACIÓN GENERAL
// ==========================================
const BASE_URL = process.env.BASE_URL || 'https://backendfresh-production.up.railway.app';
const WEB_SERVICE_URL = `${BASE_URL}/api/wallet`;
const WALLET_SECRET = process.env.WALLET_SECRET || 'fresh-market-secret-key-2025';

const GOOGLE_ISSUER_ID = '3388000000023046225';
const CLASS_NORMAL = `${GOOGLE_ISSUER_ID}.fresh_market_loyal`;
const CLASS_LEGEND = `${GOOGLE_ISSUER_ID}.fresh_market_legend`;

function formatSmartName(fullName) {
    if (!fullName) return "Cliente Fresh";
    const words = fullName.trim().split(/\s+/);
    if (words.length <= 2) return fullName;
    let shortName = words[0];
    return shortName + " " + words.slice(1).join(" ");
}

// 🛡️ FUNCIÓN DE LIMPIEZA DE ID
function cleanObjectId(id) {
    if (!id) return "";
    return id.trim().replace(/[^a-fA-F0-9]/g, "");
}

// ==========================================
// 🍏 APPLE WALLET ENDPOINT
// ==========================================
router.get('/apple/:clientId', async (req, res) => {
    try {
        let { clientId } = req.params;
        
        clientId = cleanObjectId(clientId);

        if (!mongoose.Types.ObjectId.isValid(clientId)) {
            return res.status(400).json({ error: "ID de cliente inválido o malformado." });
        }

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

        let statusText = 'Miembro Fresh';
        if (numSellos >= 8) statusText = '🎁 ¡PREMIO DISPONIBLE!';
        else if (numSellos === 0) statusText = '🌟 Bienvenido';
        else if (numSellos > 5 && numSellos < 8) statusText = '🔥 ¡YA CASI LLEGAS!';

        let appleBackgroundColor = "rgb(34, 139, 34)";
        let appleLabelColor = "rgb(200, 255, 200)";

        if (numSellos > 5) {
            appleBackgroundColor = "rgb(249, 115, 22)";
            appleLabelColor = "rgb(255, 230, 200)";
        }

        const stripFilename = `${numSellos}-sello.png`;
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
            locations: [{ latitude: 20.102220, longitude: -98.761820, relevantText: "🥕 Fresh Market te espera." }],

            storeCard: {
                headerFields: [
                    {
                        key: "header_puntos",
                        label: "Tus puntos",
                        value: `${numPuntos} pts`,
                        textAlignment: "PKTextAlignmentRight"
                    }
                ],
                primaryFields: [],
                secondaryFields: [
                    {
                        key: "balance_sellos",
                        label: "MIS SELLOS",
                        value: `${numSellos} de 8`,
                        textAlignment: "PKTextAlignmentLeft",
                        changeMessage: "¡Actualización! Ahora tienes %@ sellos 🥕"
                    },
                    {
                        key: "nombre",
                        label: "CLIENTE",
                        value: nombreLimpio,
                        textAlignment: "PKTextAlignmentRight"
                    }
                ],
                auxiliaryFields: [
                    {
                        key: "status",
                        label: "ESTATUS",
                        value: statusText,
                        textAlignment: "PKTextAlignmentCenter"
                    }
                ],
                backFields: [
                    {
                        key: "quick_links",
                        label: "📱 CONTACTO RÁPIDO",
                        value: "💬 WhatsApp Pedidos:\nhttps://wa.me/527712346620\n📸 Instagram:\nhttps://instagram.com/freshmarketp\n📘 Facebook:\nhttps://facebook.com/freshmarketp",
                        textAlignment: "PKTextAlignmentLeft"
                    },
                    {
                        key: "how_it_works",
                        label: "🙌 TU TARJETA FRESH",
                        value: "🥕 Recibe 1 sello por compras mayores a $285.\n🎉 Al juntar 8 sellos, ¡recibe un producto con valor de $100!\n💰 Tus puntos valen dinero electrónico (no son canjeables por dinero en efectivo).",
                        textAlignment: "PKTextAlignmentLeft"
                    },
                    {
                        key: "promo_title",
                        label: "📢 NOVEDADES",
                        value: "🥕 Promociones a Fresh Market!",
                        textAlignment: "PKTextAlignmentLeft",
                        changeMessage: "%@"
                    },
                    {
                        key: "account_info",
                        label: "👤 TITULAR",
                        value: `${nombreLimpio}\nNivel: ${statusText}`,
                        textAlignment: "PKTextAlignmentRight"
                    },
                    {
                        key: "contact_address",
                        label: "📍 UBICACIÓN",
                        value: "Felipe Carrillo Puerto 603, Col. Morelos, Pachuca de Soto, Hgo.",
                        textAlignment: "PKTextAlignmentLeft"
                    },
                    {
                        key: "last_update",
                        label: "⏰ Última Actualización",
                        value: new Date().toLocaleString('es-MX', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }),
                        textAlignment: "PKTextAlignmentRight"
                    }
                ]
            },
            barcodes: [
                {
                    format: "PKBarcodeFormatQR",
                    message: cliente._id.toString(),
                    messageEncoding: "iso-8859-1",
                    altText: 'fidelify.mx'
                }
            ]
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
        if (!SERVICE_ACCOUNT) return res.status(500).send("No credentials");

        let { clientId } = req.params;
        clientId = cleanObjectId(clientId);
        
        if (!mongoose.Types.ObjectId.isValid(clientId)) {
            return res.status(400).send("ID de cliente inválido.");
        }

        const cliente = await Clientes.findById(clientId);
        if (!cliente) return res.status(404).send("Cliente no encontrado");

        let numSellos = cliente.sellos || 0;
        if (numSellos > 8) numSellos = 8;

        const imageName = `${numSellos}-sello.png`;
        const heroImageUrl = `${BASE_URL}/public/freshmarket/niveles/${imageName}`;

        let selectedClassId = CLASS_NORMAL;
        if (numSellos > 5) {
            selectedClassId = CLASS_LEGEND;
        }

        const objectId = `${GOOGLE_ISSUER_ID}.${cliente._id}`;
        const nombreLimpio = cliente.nombre ? cliente.nombre.split('-')[0].trim() : "Cliente Fresh";

        let walletObject = await GoogleWalletObject.findOne({ objectId });
        let version = 1;

        if (walletObject) {
            version = walletObject.version + 1;
            if (walletObject.classId !== selectedClassId) {
                await GoogleWalletObject.updateOne(
                    { objectId },
                    { classId: selectedClassId, version, updatedAt: new Date() }
                );
            } else {
                await GoogleWalletObject.updateOne(
                    { objectId },
                    { version, updatedAt: new Date() }
                );
            }
        } else {
            walletObject = await GoogleWalletObject.create({
                objectId,
                clienteId: cliente._id,
                classId: selectedClassId,
                version: 1
            });
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
                }]
            }
        };

        const token = jwt.sign(payload, SERVICE_ACCOUNT.private_key, { algorithm: 'RS256' });
        const saveUrl = `https://pay.google.com/gp/v/save/${token}`;

        await Clientes.findByIdAndUpdate(clientId, {
            hasWallet: true,
            walletPlatform: 'google'
        });
        console.log(`✅ Cliente ${clientId} marcado con hasWallet: true (Google)`);

        res.redirect(saveUrl);

    } catch (err) {
        console.error("❌ GOOGLE ERROR:", err);
        res.status(500).send('Error interno Google');
    }
});

// ==========================================
// 🤖 GOOGLE WALLET UPDATE ENDPOINT
// ==========================================
router.put('/google-update/:clientId', async (req, res) => {
    try {
        if (!SERVICE_ACCOUNT) {
            return res.status(500).json({ success: false, error: 'No hay credenciales de Google Wallet configuradas' });
        }

        const { clientId } = req.params;
        const cleanId = cleanObjectId(clientId);

        const cliente = await Clientes.findById(cleanId);
        
        if (!cliente) {
            return res.status(404).json({ success: false, error: 'Cliente no encontrado' });
        }

        const { updateGoogleWalletObject } = require('../utils/pushGoogle');
        await updateGoogleWalletObject(cleanId);

        res.status(200).json({ success: true, message: 'Google Wallet actualizado' });

    } catch (err) {
        console.error("❌ GOOGLE UPDATE ERROR:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 🔔 NOTIFICACIÓN INDIVIDUAL
// ==========================================
router.post('/notify/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;
        const cleanId = cleanObjectId(clientId);
        
        const cliente = await Clientes.findById(cleanId);
        if (!cliente) return res.status(404).json({ success: false, error: 'No encontrado' });
        
        await notifyPassUpdate(cleanId);
        res.status(200).json({ success: true, message: 'Notificación enviada' });
        
    } catch (err) {
        console.error("❌ ERROR NOTIFY:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 🔔 NOTIFICACIÓN MASIVA
// ==========================================
router.post('/notify-bulk', async (req, res) => {
    try {
        const { clientIds } = req.body;
        if (!Array.isArray(clientIds) || clientIds.length === 0) return res.status(400).json({ error: 'Array requerido' });
        
        const success = [];
        const failed = [];
        
        for (const rawId of clientIds) {
            const clientId = cleanObjectId(rawId);
            try {
                if (!mongoose.Types.ObjectId.isValid(clientId)) continue;
                await notifyPassUpdate(clientId);
                success.push(clientId);
            } catch (err) {
                failed.push({ clientId, error: err.message });
            }
        }
        res.status(200).json({ success: true, summary: { total: clientIds.length, success: success.length, failed: failed.length } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 🔗 LINK INTELIGENTE (CORTA Y REDIRIGE)
// GET /api/wallet/go/:clientId
// ==========================================
router.get('/go/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;
        const cleanId = cleanObjectId(clientId); // Limpieza de seguridad
        
        // Detectar si es iPhone/iPad
        const userAgent = req.headers['user-agent'] || '';
        const isIOS = /iPad|iPhone|iPod/.test(userAgent) && !window.MSStream;

        if (isIOS) {
            res.redirect(`${BASE_URL}/api/wallet/apple/${cleanId}`);
        } else {
            res.redirect(`${BASE_URL}/api/wallet/google/${cleanId}`);
        }
    } catch (err) {
        console.error("Error en smart link:", err);
        res.status(500).send("Error redirigiendo");
    }
});

module.exports = router;