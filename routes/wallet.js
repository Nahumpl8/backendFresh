const router = require('express').Router();
const { PKPass } = require('passkit-generator');
const Clientes = require('../models/Clientes');
const GoogleWalletObject = require('../models/GoogleWalletObject');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

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

// ==========================================
// 🍏 APPLE WALLET ENDPOINT
// ==========================================
router.get('/apple/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;
        const cliente = await Clientes.findById(clientId);
        if (!cliente) return res.status(404).json({ error: "Cliente no encontrado" });

        // Directorios
        const baseDir = path.resolve(__dirname, '../assets/freshmarket');
        const certsDir = path.resolve(__dirname, '../certs');
        const nivelesDir = path.join(baseDir, 'niveles');

        // Certificados
        const wwdr = fs.readFileSync(path.join(certsDir, 'wwdr.pem'));
        const signerCert = fs.readFileSync(path.join(certsDir, 'signerCert.pem'));
        const signerKey = fs.readFileSync(path.join(certsDir, 'signerKey.pem'));

        // Lógica Sellos
        let numSellos = cliente.sellos || 0;
        if (numSellos > 8) numSellos = 8;
        let numPuntos = cliente.puntos || 0;

        let statusText = 'Miembro Fresh';
        if (numSellos >= 8) statusText = '🎁 ¡PREMIO DISPONIBLE!';
        else if (numSellos === 0) statusText = '🌟 Bienvenido';
        else if (numSellos > 5 && numSellos < 8) statusText = '🔥 ¡YA CASI LLEGAS!';

        // 🎨 LOGICA DE COLOR APPLE
        let appleBackgroundColor = "rgb(34, 139, 34)"; // Verde
        let appleLabelColor = "rgb(200, 255, 200)";

        if (numSellos > 5) {
            appleBackgroundColor = "rgb(249, 115, 22)"; // Naranja
            appleLabelColor = "rgb(255, 230, 200)";
        }

        // Imagen dinámica
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
                // HEADER: Puntos a la derecha del logo
                headerFields: [
                    {
                        key: "header_puntos",
                        label: "",
                        value: `${numPuntos} pts`,
                        textAlignment: "PKTextAlignmentRight"
                    }
                ],
                // 1. PUNTOS EN GRANDE (Primary)
                primaryFields: [
                    {
                        key: "puntos",
                        label: "PUNTOS DISPONIBLES",
                        value: numPuntos.toString(),
                        textAlignment: "PKTextAlignmentCenter",
                        changeMessage: "Tus puntos han cambiado a %@"
                    }
                ],
                // 2. SELLOS Y NOMBRE (Secondary)
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
                // 3. ESTATUS (Auxiliary)
                auxiliaryFields: [
                    {
                        key: "status",
                        label: "ESTATUS",
                        value: statusText,
                        textAlignment: "PKTextAlignmentCenter"
                    }
                ],
                // 4. INFORMACIÓN ATRÁS (Estilo Le Duo) ✨
                backFields: [
                    // A. Enlaces Rápidos con Emojis
                    {
                        key: "quick_links",
                        label: "📱 CONTACTO RÁPIDO",
                        // Los saltos de linea \n son clave aquí
                        value: "💬 WhatsApp Pedidos:\nhttps://wa.me/527712346620\n\n📸 Instagram:\nhttps://instagram.com/freshmarketp\n\n📘 Facebook:\nhttps://facebook.com/freshmarketp",
                        textAlignment: "PKTextAlignmentLeft"
                    },
                    // B. Explicación del programa
                    {
                        key: "how_it_works",
                        label: "🙌 TU TARJETA FRESH",
                        value: "🥕 Recibe 1 sello por compras mayores a $300.\n🎉 Al juntar 8 sellos, ¡recibe un producto con valor de $100!\n💰 Tus puntos valen dinero electrónico (no son canjeables por dinero en efectivo).",
                        textAlignment: "PKTextAlignmentLeft"
                    },
                    // C. Info del Cliente
                    {
                        key: "account_info",
                        label: "👤 TITULAR",
                        value: `${nombreLimpio}\nNivel: ${statusText}`,
                        textAlignment: "PKTextAlignmentRight"
                    },
                    // D. Dirección
                    {
                        key: "contact_address",
                        label: "📍 UBICACIÓN",
                        value: "Blvd. Valle de San Javier 301, Pachuca de Soto, Hgo.",
                        textAlignment: "PKTextAlignmentLeft"
                    },
                    // E. Fecha
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
                    altText: nombreLimpio
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
// 🤖 GOOGLE WALLET ENDPOINT (IGUAL)
// ==========================================
router.get('/google/:clientId', async (req, res) => {
    try {
        if (!SERVICE_ACCOUNT) return res.status(500).send("No credentials");

        const { clientId } = req.params;
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

        // ObjectId persistente basado en clienteId (sin timestamp)
        const objectId = `${GOOGLE_ISSUER_ID}.${cliente._id}`;

        const nombreLimpio = cliente.nombre ? cliente.nombre.split('-')[0].trim() : "Cliente Fresh";

        // Verificar si el objeto ya existe
        let walletObject = await GoogleWalletObject.findOne({ objectId });
        let version = 1;

        if (walletObject) {
            // Si existe, incrementar versión y usar la classId existente si no cambió
            version = walletObject.version + 1;
            // Si cambió de clase (normal a legend o viceversa), actualizar
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
            // Crear nuevo objeto en BD
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
        const cliente = await Clientes.findById(clientId);
        
        if (!cliente) {
            return res.status(404).json({ success: false, error: 'Cliente no encontrado' });
        }

        // Importar función de actualización
        const { updateGoogleWalletObject } = require('../utils/pushGoogle');
        
        // Actualizar objeto
        await updateGoogleWalletObject(clientId);

        res.status(200).json({
            success: true,
            message: 'Google Wallet actualizado exitosamente'
        });

    } catch (err) {
        console.error("❌ GOOGLE UPDATE ERROR:", err);
        res.status(500).json({
            success: false,
            error: err.message || 'Error al actualizar Google Wallet'
        });
    }
});

module.exports = router;