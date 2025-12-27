const router = require('express').Router();
const WalletDevice = require('../models/WalletDevice');
const Clientes = require('../models/Clientes');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { PKPass } = require('passkit-generator');

// SECRETOS (Deben coincidir con wallet.js)
const WALLET_SECRET = process.env.WALLET_SECRET || 'fresh-market-secret-key-2025';
const BASE_URL = process.env.BASE_URL || 'https://backendfresh-production.up.railway.app';
const WEB_SERVICE_URL = `${BASE_URL}/api/wallet`; // Sin /v1, Apple lo agrega solo

// Helper para validar el token de seguridad
function validateAuthToken(authHeader, serialNumber) {
    if (!authHeader) return false;
    const token = authHeader.replace('ApplePass ', '');
    const clientId = serialNumber.replace('FRESH-', '');

    // Recalculamos el token esperado
    const expectedToken = crypto.createHmac('sha256', WALLET_SECRET)
        .update(clientId)
        .digest('hex');

    return token === expectedToken;
}

// ==================================================================
// 1️⃣ REGISTRO: El iPhone dice "¡Hola! Guarda mi Push Token"
// POST /v1/devices/:deviceID/registrations/:passTypeID/:serial#
// ==================================================================
router.post('/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber', async (req, res) => {
    try {
        const { deviceId, passTypeId, serialNumber } = req.params;
        const { pushToken } = req.body; // Apple nos manda esto

        console.log(`📲 Registro Apple Wallet recibido: ${serialNumber}`);

        // 1. Validar Seguridad
        if (!validateAuthToken(req.headers.authorization, serialNumber)) {
            console.error('❌ Token inválido');
            return res.sendStatus(401);
        }

        // 2. Guardar en Base de Datos (Si ya existe, actualiza el token)
        await WalletDevice.findOneAndUpdate(
            { deviceLibraryIdentifier: deviceId, serialNumber: serialNumber },
            {
                pushToken: pushToken,
                passTypeIdentifier: passTypeId
            },
            { upsert: true, new: true }
        );

        res.sendStatus(201); // Éxito
    } catch (err) {
        console.error("❌ Error registrando dispositivo:", err);
        res.sendStatus(500);
    }
});

// ==================================================================
// 2️⃣ CONSULTA: El iPhone pregunta "¿Hay algo nuevo para mí?"
// GET /v1/devices/:deviceID/registrations/:passTypeID
// ==================================================================
router.get('/v1/devices/:deviceId/registrations/:passTypeId', async (req, res) => {
    try {
        const { deviceId, passTypeId } = req.params;

        // Buscamos si este iPhone tiene pases registrados
        const registrations = await WalletDevice.find({
            deviceLibraryIdentifier: deviceId,
            passTypeIdentifier: passTypeId
        });

        if (registrations.length === 0) return res.sendStatus(204); // Nada por aquí

        // Respondemos con la lista de pases que cambiaron (serialNumbers)
        // El campo "passesUpdatedSince" se usa para filtrar por fecha, 
        // pero para simplificar siempre devolvemos todo (Apple lo maneja bien).
        const serials = registrations.map(reg => reg.serialNumber);

        res.json({
            lastUpdated: new Date().toISOString(),
            serialNumbers: serials
        });
    } catch (err) {
        console.error("❌ Error consultando actualizaciones:", err);
        res.sendStatus(500);
    }
});

// ==================================================================
// 3️⃣ ENTREGA: El iPhone pide "Dame la última versión del pase"
// GET /v1/passes/:passTypeID/:serial#
// ==================================================================
// ==================================================================
// 3️⃣ ENTREGA: El iPhone pide "Dame la última versión del pase"
// GET /v1/passes/:passTypeID/:serial#
// ==================================================================
router.get('/v1/passes/:passTypeId/:serialNumber', async (req, res) => {
    try {
        const { serialNumber } = req.params;

        // 1. Validar Seguridad
        if (!validateAuthToken(req.headers.authorization, serialNumber)) {
            return res.sendStatus(401);
        }

        // 2. Buscar Cliente
        const clientId = serialNumber.replace('FRESH-', '');
        const cliente = await Clientes.findById(clientId);
        if (!cliente) return res.sendStatus(404);

        // ==============================================================
        // 🚦 CONTROL DE CACHÉ (Solución al error del Log)
        // ==============================================================
        // Obtenemos la fecha de última modificación REAL del cliente en Mongo
        const lastModified = new Date(cliente.updatedAt);

        // Redondeamos a segundos (los headers HTTP no manejan milisegundos)
        const lastModifiedTime = Math.floor(lastModified.getTime() / 1000);

        // Verificamos si Apple nos envió el header "If-Modified-Since"
        const ifModifiedSince = req.headers['if-modified-since'];

        if (ifModifiedSince) {
            const ifModifiedTime = Math.floor(new Date(ifModifiedSince).getTime() / 1000);

            // Si la fecha del cliente es igual o anterior a la que tiene Apple...
            if (lastModifiedTime <= ifModifiedTime) {
                console.log(`⛔ 304 Not Modified para ${serialNumber}`);
                return res.status(304).end(); // Le decimos: "No descargues nada, usa el que tienes"
            }
        }
        // ==============================================================

        console.log(`📥 iPhone descargando actualización REAL para: ${serialNumber}`);

        // --- REGENERAR EL PASE ---
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
        const nombreLimpio = cliente.nombre ? cliente.nombre.split('-')[0].trim() : "Cliente"; // Tu helper simplificado

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
            // 🔒 TRUCO: Campo invisible que cambia siempre para evitar "unchanged pass data"
            // Esto obliga a que el binario sea diferente aunque los datos sean iguales
            userInfo: {
                generatedAt: new Date().toISOString(),
                updateTrigger: lastModifiedTime
            },
            locations: [{ latitude: 20.102220, longitude: -98.761820, relevantText: "🥕 Fresh Market te espera." }],
            storeCard: {
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
                backFields: [
                    { key: "whatsapp", label: "📞 PEDIDOS WHATSAPP", value: "771-234-6620", textAlignment: "PKTextAlignmentLeft" },
                    { key: "socials", label: "📱 SÍGUENOS", value: "FB: Fresh Market Pachuca\nIG: @freshmarketpachuca", textAlignment: "PKTextAlignmentLeft" },
                    { key: "terms", label: "📄 TÉRMINOS", value: "Acumula 1 sello por cada compra >$300.", textAlignment: "PKTextAlignmentLeft" },
                    { key: "last_update", label: "Última Actualización", value: lastModified.toLocaleString('es-MX'), textAlignment: "PKTextAlignmentRight" }
                ]
            },
            barcode: { format: "PKBarcodeFormatQR", message: cliente._id.toString(), encoding: "iso-8859-1", altText: nombreLimpio }
        };

        const finalBuffers = { ...buffers, 'pass.json': Buffer.from(JSON.stringify(passJson)) };
        const pass = new PKPass(finalBuffers, { wwdr, signerCert, signerKey });
        const buffer = await pass.getAsBuffer();

        // 3. Headers Correctos
        res.set('Content-Type', 'application/vnd.apple.pkpass');
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); // Forzamos a no cachear intermedios
        res.set('Last-Modified', lastModified.toUTCString()); // Enviamos la fecha real de Mongo

        res.send(buffer);

    } catch (err) {
        console.error("❌ Error generando actualización:", err);
        res.sendStatus(500);
    }
});
// ==================================================================
// 4️⃣ BAJA: El usuario borró el pase de su Wallet
// DELETE /v1/devices/:deviceID/registrations/:passTypeID/:serial#
// ==================================================================
router.delete('/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber', async (req, res) => {
    try {
        const { deviceId, serialNumber } = req.params;

        // Validación token
        if (!validateAuthToken(req.headers.authorization, serialNumber)) return res.sendStatus(401);

        await WalletDevice.findOneAndDelete({
            deviceLibraryIdentifier: deviceId,
            serialNumber: serialNumber
        });

        console.log(`🗑️ Pase eliminado de Wallet: ${serialNumber}`);
        res.sendStatus(200);
    } catch (err) {
        res.sendStatus(500);
    }
});

// LOGS (Opcional, Apple a veces manda errores aquí)
router.post('/v1/log', (req, res) => {
    console.log('🍎 Apple Log:', req.body);
    res.sendStatus(200);
});

module.exports = router;