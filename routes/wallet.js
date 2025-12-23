const router = require('express').Router();
const { PKPass } = require('passkit-generator');
const Clientes = require('../models/Clientes');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ==========================================
// ⚙️ CONFIGURACIÓN
// ==========================================
const WEB_SERVICE_URL = process.env.WEB_SERVICE_URL || 'https://tu-app-railway.app/api/wallet';
const WALLET_SECRET = process.env.WALLET_SECRET || 'fresh-market-secret-key-2025';

// Helper para limpiar nombres
function formatSmartName(fullName) {
    if (!fullName) return "Cliente Fresh";
    const words = fullName.trim().split(/\s+/);
    if (words.length <= 2) return fullName;

    let shortName = words[0];
    let remainingWords = words.slice(1);
    const conectores = ['de', 'del', 'la', 'las', 'los', 'san', 'y'];
    let apellido = "";

    for (let i = 0; i < remainingWords.length; i++) {
        const word = remainingWords[i];
        if (conectores.includes(word.toLowerCase())) {
            apellido += " " + word;
        } else {
            apellido += " " + word;
            break;
        }
    }
    return shortName + apellido;
}

// ==========================================
// 🍏 APPLE WALLET ENDPOINT
// ==========================================
router.get('/apple/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;

        // 1. BUSCAR CLIENTE
        const cliente = await Clientes.findById(clientId);
        if (!cliente) return res.status(404).json({ error: "Cliente no encontrado" });

        // 2. RUTAS DE ARCHIVOS
        const baseDir = path.resolve(__dirname, '../assets/freshmarket');
        const certsDir = path.resolve(__dirname, '../certs');
        const nivelesDir = path.join(baseDir, 'niveles');

        // 3. LEER CERTIFICADOS
        const wwdr = fs.readFileSync(path.join(certsDir, 'wwdr.pem'));
        const signerCert = fs.readFileSync(path.join(certsDir, 'signerCert.pem'));
        const signerKey = fs.readFileSync(path.join(certsDir, 'signerKey.pem'));

        // 4. LÓGICA DE DATOS (NUEVA LÓGICA DE 8 SELLOS)

        // A) Sellos
        let numSellos = cliente.sellos || 0;
        // Tope máximo ahora es 8
        if (numSellos > 8) numSellos = 8;

        // B) Puntos
        let numPuntos = cliente.puntos || 0;

        // C) Nivel y Estado
        let statusText = 'Cliente Fresh';
        if (numSellos >= 8) {
            statusText = '🎁 PREMIO DISPONIBLE ($100)';
        } else if (numSellos === 0) {
            statusText = '🌟 BIENVENIDO';
        }

        // D) Lógica de Bienvenida (Plátano Gratis)
        // Usaremos el campo Primary para destacar esto si es nuevo
        let welcomeField = null;
        if (numSellos === 0) {
            welcomeField = {
                key: "welcome_gift",
                label: "REGALO DE BIENVENIDA",
                value: "🍌 1kg Plátano GRATIS",
                textAlignment: "PKTextAlignmentCenter"
            };
        }

        // Buscamos la imagen dinámica (ej: "3-sello.png")
        // Asegúrate de tener imágenes del 0 al 8 en tu carpeta niveles
        const stripFilename = `${numSellos}-sello.png`;
        const stripPath = path.join(nivelesDir, stripFilename);
        const finalStripPath = fs.existsSync(stripPath) ? stripPath : path.join(nivelesDir, '0-sello.png');

        // 5. TOKEN PUSH
        const authToken = crypto.createHmac('sha256', WALLET_SECRET)
            .update(cliente._id.toString())
            .digest('hex');

        // 6. BUFFERS
        const buffers = {
            'icon.png': fs.readFileSync(path.join(baseDir, 'icon.png')),
            'icon@2x.png': fs.readFileSync(path.join(baseDir, 'icon.png')),
            'logo.png': fs.readFileSync(path.join(baseDir, 'logo.png')),
            'logo@2x.png': fs.readFileSync(path.join(baseDir, 'logo.png')),
            'strip.png': fs.readFileSync(finalStripPath),
            'strip@2x.png': fs.readFileSync(finalStripPath)
        };

        const nombreLimpio = formatSmartName(cliente.nombre);

        // 7. CONSTRUIR JSON
        const passJson = {
            formatVersion: 1,
            passTypeIdentifier: "pass.com.freshmarket.pachuca", // Asegúrate que este ID coincida con tus certificados nuevos
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

            // 📍 GEOLOCALIZACIÓN
            // Aquí puedes poner tu bodega en Pachuca o zonas clave
            locations: [
                {
                    latitude: 20.102220,
                    longitude: -98.761820,
                    relevantText: "🥕 ¿Ya pediste tu despensa? Fresh Market te espera, escríbenos al 7712346620."
                }
            ],

            storeCard: {
                // HEADER: Puntos
                headerFields: [
                    {
                        key: "puntos_header",
                        label: "MIS PUNTOS",
                        value: numPuntos.toString(),
                        textAlignment: "PKTextAlignmentRight"
                    }
                ],

                // PRIMARY: Regalo de Bienvenida (Solo aparece si tiene 0 sellos)
                primaryFields: [],

                // SECONDARY: Sellos
                secondaryFields: [
                    {
                        key: 'balance_sellos',
                        label: 'SELLOS',
                        value: `${numSellos}/8`, // Actualizado a 8
                        textAlignment: "PKTextAlignmentLeft",
                        changeMessage: '¡Tu pedido ha llegado! 🥕 Ahora tienes %@ sellos.'
                    },
                    {
                        key: 'name',
                        label: 'MIEMBRO',
                        value: nombreLimpio,
                        textAlignment: "PKTextAlignmentRight"
                    }
                ],

                // AUXILIARY: Estatus del Premio
                auxiliaryFields: [
                    {
                        key: "status_premio",
                        label: "ESTATUS",
                        value: statusText,
                        textAlignment: "PKTextAlignmentCenter"
                    }
                ],

                // BACKFIELDS
                backFields: [
                    {
                        key: 'quick_links',
                        label: '📱 HAZ TU PEDIDO',
                        value: '📝 WhatsApp Pedidos:\nhttps://www.wa.me/5217712346620\n📸 Instagram:\nhttps://www.instagram.com/fresh_marketp\n🤩 Facebook:\nhttps://www.facebook.com/freshmarketp/',
                        textAlignment: 'PKTextAlignmentLeft'
                    },
                    {
                        key: 'weekly_promo',
                        label: '🥕 NOVEDADES SEMANALES',
                        value: '¡Bienvenido a la comunidad Fresh Market! 🍌\nRevisa nuestras historias de Instagram para ver las frutas de temporada.',
                        changeMessage: '%@'
                    },
                    {
                        key: 'how_it_works',
                        label: '🙌 TU BENEFICIO FRESH',
                        value: '1️⃣ Recibe 1 sello por cada pedido entregado.\n2️⃣ Al juntar 8 sellos, ¡tu siguiente pedido tiene PREMIO!\n🎁 El 9º pedido incluye un producto con valor de hasta $90.\n🍌 Regalo de bienvenida: 1kg de Plátano en tu 1er pedido.',
                        textAlignment: 'PKTextAlignmentLeft'
                    },
                    {
                        key: 'account_info',
                        label: '🫶 TITULAR',
                        value: `${nombreLimpio}\nID: FRESH-${cliente._id.toString().slice(-4)}`,
                        textAlignment: 'PKTextAlignmentRight'
                    },
                    {
                        key: 'contact_footer',
                        label: '📞 CONTACTO',
                        value: 'Tel: 7712346620\nEntregamos en todo Pachuca y Mineral de la Reforma.\n© 2025 Fresh Market 🥩',
                        textAlignment: 'PKTextAlignmentLeft'
                    }
                ]
            },
            barcode: {
                format: "PKBarcodeFormatQR",
                message: cliente._id.toString(),
                messageEncoding: "iso-8859-1",
                altText: nombreLimpio
            }
        };

        // ... resto del código de generación de pass (igual) ...

        const finalBuffers = {
            ...buffers,
            'pass.json': Buffer.from(JSON.stringify(passJson))
        };

        const pass = new PKPass(finalBuffers, {
            wwdr,
            signerCert,
            signerKey,
        });

        const buffer = await pass.getAsBuffer();

        res.set('Content-Type', 'application/vnd.apple.pkpass');
        res.set('Content-Disposition', `attachment; filename=fresh-${cliente._id}.pkpass`);
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');

        res.send(buffer);
        console.log(`✅ Pase generado para ${nombreLimpio} (Sellos: ${numSellos}/8)`);

    } catch (err) {
        console.error("❌ ERROR:", err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;