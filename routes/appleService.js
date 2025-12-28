const router = require('express').Router();
const WalletDevice = require('../models/WalletDevice');
const Clientes = require('../models/Clientes');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { PKPass } = require('passkit-generator');

// SECRETOS
const WALLET_SECRET = process.env.WALLET_SECRET || 'fresh-market-secret-key-2025';
const BASE_URL = process.env.BASE_URL || 'https://backendfresh-production.up.railway.app';
const WEB_SERVICE_URL = `${BASE_URL}/api/wallet`; 

function validateAuthToken(authHeader, serialNumber) {
    if (!authHeader) return false;
    const token = authHeader.replace('ApplePass ', '');
    const clientId = serialNumber.replace('FRESH-', '');
    const expectedToken = crypto.createHmac('sha256', WALLET_SECRET).update(clientId).digest('hex');
    return token === expectedToken;
}

// 1. REGISTRO
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
        res.sendStatus(201);
    } catch (err) {
        console.error("❌ Error registrando:", err);
        res.sendStatus(500);
    }
});

// 2. CONSULTA
router.get('/v1/devices/:deviceId/registrations/:passTypeId', async (req, res) => {
    try {
        const { deviceId, passTypeId } = req.params;
        const registrations = await WalletDevice.find({ deviceLibraryIdentifier: deviceId, passTypeIdentifier: passTypeId });
        if (registrations.length === 0) return res.sendStatus(204);

        const serials = registrations.map(reg => reg.serialNumber);
        res.json({ lastUpdated: new Date().toISOString(), serialNumbers: serials });
    } catch (err) {
        res.sendStatus(500);
    }
});

// 3. ENTREGA (CON DISEÑO LE DUO)
router.get('/v1/passes/:passTypeId/:serialNumber', async (req, res) => {
    try {
        const { serialNumber } = req.params;

        if (!validateAuthToken(req.headers.authorization, serialNumber)) return res.sendStatus(401);

        const clientId = serialNumber.replace('FRESH-', '');
        const cliente = await Clientes.findById(clientId);
        if (!cliente) return res.sendStatus(404);

        // CACHE CONTROL
        const lastModified = new Date(cliente.updatedAt);
        const lastModifiedTime = Math.floor(lastModified.getTime() / 1000);
        const ifModifiedSince = req.headers['if-modified-since'];
        if (ifModifiedSince) {
            const ifModifiedTime = Math.floor(new Date(ifModifiedSince).getTime() / 1000);
            if (lastModifiedTime <= ifModifiedTime) {
                console.log(`⛔ 304 Not Modified para ${serialNumber}`);
                return res.status(304).end();
            }
        }

        console.log(`📥 iPhone actualizando: ${serialNumber}`);

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
        const nombreLimpio = cliente.nombre ? cliente.nombre.split('-')[0].trim() : "Cliente";

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
            userInfo: { generatedAt: new Date().toISOString(), updateTrigger: lastModifiedTime },
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
                primaryFields: [
                    { key: "puntos", label: "PUNTOS DISPONIBLES", value: numPuntos.toString(), textAlignment: "PKTextAlignmentCenter", changeMessage: "Tus puntos han cambiado a %@" }
                ],
                secondaryFields: [
                    { key: 'balance_sellos', label: 'MIS SELLOS', value: `${numSellos} de 8`, textAlignment: "PKTextAlignmentLeft", changeMessage: "¡Actualización! Ahora tienes %@ sellos 🥕" },
                    { key: 'nombre', label: 'CLIENTE', value: nombreLimpio, textAlignment: "PKTextAlignmentRight" }
                ],
                auxiliaryFields: [
                    { key: "status", label: "ESTATUS", value: statusText, textAlignment: "PKTextAlignmentCenter" }
                ],
                // DISEÑO TRASERO ESTILO LE DUO
                backFields: [
                    {
                        key: "quick_links",
                        label: "📱 CONTACTO RÁPIDO",
                        value: "💬 WhatsApp Pedidos:\nhttps://wa.me/527712346620\n\n📸 Instagram:\nhttps://instagram.com/freshmarketp\n\n📘 Facebook:\nhttps://facebook.com/freshmarketp",
                        textAlignment: "PKTextAlignmentLeft"
                    },
                    {
                        key: "how_it_works",
                        label: "🙌 TU TARJETA FRESH",
                        value: "🥕 Recibe 1 sello por compras mayores a $300.\n🎉 Al juntar 8 sellos, ¡recibe un producto con valor de $100!\n💰 Tus puntos valen dinero electrónico (no son canjeables por dinero en efectivo).",
                        textAlignment: "PKTextAlignmentLeft"
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
                        value: "Blvd. Valle de San Javier 301, Pachuca de Soto, Hgo.",
                        textAlignment: "PKTextAlignmentLeft"
                    },
                    {
                        key: "last_update",
                        label: "⏰ Última Actualización",
                        value: lastModified.toLocaleString('es-MX', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }),
                        textAlignment: "PKTextAlignmentRight"
                    }
                ]
            },
            barcode: { format: "PKBarcodeFormatQR", message: cliente._id.toString(), encoding: "iso-8859-1", altText: nombreLimpio }
        };

        const finalBuffers = { ...buffers, 'pass.json': Buffer.from(JSON.stringify(passJson)) };
        const pass = new PKPass(finalBuffers, { wwdr, signerCert, signerKey });
        const buffer = await pass.getAsBuffer();

        res.set('Content-Type', 'application/vnd.apple.pkpass');
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.set('Last-Modified', lastModified.toUTCString());

        res.send(buffer);
    } catch (err) {
        console.error("❌ Error actualizando:", err);
        res.sendStatus(500);
    }
});

// 4. BAJA
router.delete('/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber', async (req, res) => {
    try {
        const { deviceId, serialNumber } = req.params;
        if (!validateAuthToken(req.headers.authorization, serialNumber)) return res.sendStatus(401);
        await WalletDevice.findOneAndDelete({ deviceLibraryIdentifier: deviceId, serialNumber: serialNumber });
        res.sendStatus(200);
    } catch (err) { res.sendStatus(500); }
});

// LOGS
router.post('/v1/log', (req, res) => { console.log('🍎 Log:', req.body); res.sendStatus(200); });

module.exports = router;