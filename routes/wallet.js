const router = require('express').Router();
const { PKPass } = require('passkit-generator');
const Clientes = require('../models/Clientes'); // Asegúrate que la mayúscula coincida con tu archivo
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ==========================================
// ⚙️ CONFIGURACIÓN
// ==========================================
const WEB_SERVICE_URL = process.env.WEB_SERVICE_URL || 'https://tu-app-railway.app/api/wallet';
const WALLET_SECRET = process.env.WALLET_SECRET || 'fresh-market-secret-key-2025';

// Helper para limpiar nombres (Smart Name)
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
        const certsDir = path.resolve(__dirname, '../certs'); // Ojo: verifica si es ../certs o ../assets/freshmarket/certs según tu estructura final
        const nivelesDir = path.join(baseDir, 'niveles');

        // 3. LEER CERTIFICADOS
        const wwdr = fs.readFileSync(path.join(certsDir, 'wwdr.pem'));
        const signerCert = fs.readFileSync(path.join(certsDir, 'signerCert.pem'));
        const signerKey = fs.readFileSync(path.join(certsDir, 'signerKey.pem'));

        // 4. LÓGICA DE DATOS (Puntos + Sellos)
        // A) Sellos (Para la imagen y meta semanal)
        let numSellos = cliente.sellos || 0;
        if (numSellos > 10) numSellos = 10;

        // B) Puntos (Para el Header - Dinero acumulado)
        let numPuntos = cliente.puntos || 0;

        // Determinar el nivel
        let level = 'Cliente Fresh';
        if (numSellos >= 10) level = 'Fresh Legend';
        else if (numSellos >= 5) level = 'Cliente Frecuente';

        // Buscamos la imagen dinámica (ej: "3-sello.png")
        const stripFilename = `${numSellos}-sello.png`;
        const stripPath = path.join(nivelesDir, stripFilename);
        const finalStripPath = fs.existsSync(stripPath) ? stripPath : path.join(nivelesDir, '0-sello.png');

        // 5. TOKEN PUSH (Seguridad)
        const authToken = crypto.createHmac('sha256', WALLET_SECRET)
            .update(cliente._id.toString())
            .digest('hex');

        // 6. PREPARAR BUFFERS DE IMÁGENES
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
            passTypeIdentifier: "pass.com.freshmarket.pachuca",
            serialNumber: `FRESH-${cliente._id}`,
            teamIdentifier: "L4P8PF94N6",
            organizationName: "Fresh Market",
            description: "Tarjeta de Lealtad",
            logoText: "Fresh Market",

            // 🎨 COLORES (Optimizados para fondo verde)
            foregroundColor: "rgb(255, 255, 255)", // Blanco (Texto de valores)
            backgroundColor: "rgb(34, 139, 34)",   // Verde Fresh
            labelColor: "rgb(200, 255, 200)",      // Verde muy claro (Para que las etiquetas "SELLOS" se lean bien)

            webServiceURL: WEB_SERVICE_URL,
            authenticationToken: authToken,

            locations: [
                {
                    latitude: 20.102220,
                    longitude: -98.761820,
                    relevantText: "¡Hola Fresh Marketero! No olvides pedir tu despensa 🥕"
                }
            ],

            storeCard: {
                // 🔥 HEADER: Aquí van los PUNTOS (Globales)
                headerFields: [
                    {
                        key: "puntos_header",
                        label: "MIS PUNTOS",
                        value: numPuntos.toString(), // Muestra solo el número
                        textAlignment: "PKTextAlignmentRight"
                    }
                ],

                // PRIMARY: Vacío (para que luzca la imagen Strip)
                primaryFields: [],

                // SECONDARY: Aquí van los SELLOS (Semana) y el NOMBRE
                secondaryFields: [
                    {
                        key: 'balance_sellos',
                        label: 'SELLOS',
                        value: `${numSellos}/10`,
                        textAlignment: "PKTextAlignmentLeft"
                    },
                    {
                        key: 'name',
                        label: 'MIEMBRO',
                        value: nombreLimpio,
                        textAlignment: "PKTextAlignmentRight"
                    }
                ],

                // AUXILIARY: Estatus
                auxiliaryFields: [
                    {
                        key: "status_premio",
                        label: "ESTATUS",
                        value: numSellos >= 10 ? "🎁 PREMIO DISPONIBLE" : level,
                        textAlignment: "PKTextAlignmentCenter"
                    }
                ],

                // BACKFIELDS: Info y WhatsApp
                backFields: [
                    {
                        key: 'quick_links',
                        label: '📱 SÍGUENOS en redes',
                        value: '📸 Instagram:\nhttps://www.instagram.com/fresh_marketp\n🤩 Facebook:\nhttps://www.facebook.com/freshmarketp/\n📝 Haz tu pedido:\nhttps://www.wa.me/5217712346620',
                        textAlignment: 'PKTextAlignmentLeft'
                    },
                    {
                        key: 'weekly_promo',
                        label: '🥕 NOVEDADES Fresh Market 🔔',
                        value: '¡Bienvenido a la comunidad Fresh Market! 🙌🍌\nMantente atento a este espacio: aquí publicaremos promociones relámpago y regalos exclusivos cada semana.',
                        changeMessage: '%@'
                    },
                    {
                        key: 'how_it_works',
                        label: '🙌 CÓMO FUNCIONA',
                        value: '☕ Recibe 1 sello por cada compra mayor a $285.\n🎉 Al juntar 5 sellos, ¡tenemos un regalo!\n🎁 Al juntar 10 sellos llevate un producto especial.\n🎂 Regalo especial en tu cumpleaños.',
                        textAlignment: 'PKTextAlignmentLeft'
                    },
                    {
                        key: 'account_info',
                        label: '🫶 TITULAR',
                        value: `${nombreLimpio}\nNivel: ${level}`,
                        textAlignment: 'PKTextAlignmentRight'
                    },
                    {
                        key: 'contact_footer',
                        label: '📞 CONTACTO',
                        value: 'Tel: 7712346620\nWeb: https://www.freshmarket.mx\nEntregamos en todo Pachuca.\n© 2025 Fresh Market 🥩\n\nPowered by Passio',
                        textAlignment: 'PKTextAlignmentLeft'
                    },
                    {
                        key: 'last_update',
                        label: '⏰ Actualizado',
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
        console.log(`✅ Pase generado para ${nombreLimpio} (Puntos: ${numPuntos}, Sellos: ${numSellos})`);

    } catch (err) {
        console.error("❌ ERROR:", err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;