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

// Helper para limpiar nombres (como hicimos antes)
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

        // 4. IMAGEN DINÁMICA (STRIP) + DETERMINAR NIVEL
        let numSellos = cliente.sellos || 0;
        if (numSellos > 10) numSellos = 10;

        // Determinar el nivel según los sellos
        let level = 'Cliente Fresh';
        if (numSellos >= 10) level = 'Fresh Leyend';
        else if (numSellos >= 5) level = 'Cliente Fresh';

        // Buscamos la imagen (ej: "3-sello.png")
        const stripFilename = `${numSellos}-sello.png`;
        const stripPath = path.join(nivelesDir, stripFilename);
        const finalStripPath = fs.existsSync(stripPath) ? stripPath : path.join(nivelesDir, '0-sello.png');

        // 5. TOKEN PUSH
        const authToken = crypto.createHmac('sha256', WALLET_SECRET)
            .update(cliente._id.toString())
            .digest('hex');

        // 6. PREPARAR BUFFERS
        const buffers = {
            'icon.png': fs.readFileSync(path.join(baseDir, 'icon.png')),
            'icon@2x.png': fs.readFileSync(path.join(baseDir, 'icon.png')),
            'logo.png': fs.readFileSync(path.join(baseDir, 'logo.png')),
            'logo@2x.png': fs.readFileSync(path.join(baseDir, 'logo.png')),
            'strip.png': fs.readFileSync(finalStripPath),
            'strip@2x.png': fs.readFileSync(finalStripPath)
        };

        const nombreLimpio = formatSmartName(cliente.nombre);

        // 7. CONSTRUIR JSON (Estilo Le Duo + WhatsApp)
        const passJson = {
            formatVersion: 1,
            passTypeIdentifier: "pass.com.freshmarket.pachuca",
            serialNumber: `FRESH-${cliente._id}`,
            teamIdentifier: "L4P8PF94N6",
            organizationName: "Fresh Market",
            description: "Tarjeta de Lealtad Fresh Market",
            logoText: "Fresh Market",

            // Colores limpios
            foregroundColor: "rgb(255, 255, 255)",
            backgroundColor: "rgb(34, 139, 34)",
            labelColor: "rgb(54, 54, 54)",

            webServiceURL: WEB_SERVICE_URL,
            authenticationToken: authToken,

            locations: [
                {
                    latitude: 20.102220,
                    longitude: -98.761820,
                    relevantText: "¡Hola Fresh Marketero! No olvides pedir tu despensa Fresh Market 🥕"
                }
            ],

            logoText: 'Tarjeta de Lealtad Fresh Market',

            storeCard: {
                headerFields: [],
                primaryFields: [],
                secondaryFields: [
                    {
                        key: 'balance',
                        label: 'SELLOS',
                        value: `${numSellos}/10`,
                        textAlignment: 'PKTextAlignmentLeft'
                    },
                    {
                        key: 'name',
                        label: 'NOMBRE',
                        value: nombreLimpio,
                        textAlignment: 'PKTextAlignmentRight'
                    }
                ],
                backFields: [
                    // 1. SECCIÓN DE ENLACES RÁPIDOS (Emojis simulando iconos)
                    {
                        key: 'quick_links',
                        label: '📱 SIGUENOS en redes',
                        // Usamos \n para saltos de línea limpios
                        value: '📸 Instagram:\nhttps://www.instagram.com/fresh_marketp\n🤩 Facebook:\nhttps://www.facebook.com/freshmarketp/\n📝 Haz tu pedido:\nhttps://www.wa.me/5217712346620',
                        textAlignment: 'PKTextAlignmentLeft'
                    },

                    // 2. SECCIÓN DE NOTICIAS (Dinámica)
                    {
                        key: 'weekly_promo',
                        label: '🥕 NOVEDADES Fresh Market 🔔',
                        value: '¡Bienvenido a la comunidad Fresh Market! 🙌🍌\nMantente atento a este espacio: aquí publicaremos promociones relámpago y regalos exclusivos cada semana.',
                        changeMessage: '%@'
                    },

                    // 3. SECCIÓN EDUCATIVA (Cómo funciona)
                    {
                        key: 'how_it_works',
                        label: '🙌 TU TARJETA Fresh Market',
                        value: '🆕 Ahora tu lealtad se recompensa mejor.\n\n☕ Recibe 1 sello por cada compra mayor a $285.\n🎉 Al juntar 5 sellos, ¡tenemos un regalo para ti!\nAl juntar 10 sellos llevate un producto de valor no mayor a $100.\n🎂 Actualiza tu información y recibe un regalo especial en tu cumpleaños.\n',
                        textAlignment: 'PKTextAlignmentLeft'
                    },

                    // 4. DATOS DEL CLIENTE (Personalización)
                    {
                        key: 'account_info',
                        label: '🫶 TITULAR DE LA CUENTA',
                        value: `${nombreLimpio}\nNivel: ${level}`,
                        textAlignment: 'PKTextAlignmentRight'
                    },

                    // 5. CONTACTO Y LEGALES
                    {
                        key: 'contact_footer',
                        label: '📞 ENLACES DE INTERÉS',
                        value: '📞 Tel: 7712346620\n🌐 Web: https://www.freshmarket.mx\n📍 Entregamos en todo Pachuca y Mineral de la Reforma.\n© 2025 Fresh Market Pachuca 🥩\n\nwww.fidelify.mx',
                        textAlignment: 'PKTextAlignmentLeft'
                    },

                    // 6. TIMESTAMP (Para verificar actualizaciones)
                    {
                        key: 'last_update',
                        label: '⏰ Última Actualización',
                        value: new Date().toLocaleString('es-MX', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }),
                        textAlignment: 'PKTextAlignmentRight'
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
        console.log(`✅ Pase generado con WhatsApp Link para ${nombreLimpio}`);

    } catch (err) {
        console.error("❌ ERROR:", err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;