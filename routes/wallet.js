const router = require('express').Router();
const { PKPass } = require('passkit-generator');
const fs = require('fs');
const path = require('path');

// ==========================================
// 🍏 APPLE WALLET ENDPOINT (Estrategia Le Duo)
// ==========================================
router.get('/apple/:clientId', async (req, res) => {
    try {
        console.log("--- Generando Pase (Estilo Le Duo) ---");

        // 1. DEFINIR RUTAS (Certificados e Imágenes)
        const certsDir = path.resolve(__dirname, '../certs');
        const imagesDir = path.resolve(__dirname, '../certs/fresh.pass');

        // Leer certificados
        const wwdr = fs.readFileSync(path.join(certsDir, 'wwdr.pem'));
        const signerCert = fs.readFileSync(path.join(certsDir, 'signerCert.pem'));
        const signerKey = fs.readFileSync(path.join(certsDir, 'signerKey.pem'));

        // Leer imágenes (Las leemos nosotros, no la librería)
        const iconBuffer = fs.readFileSync(path.join(imagesDir, 'icon.png'));
        const logoBuffer = fs.readFileSync(path.join(imagesDir, 'logo.png'));
        // Si tienes strip.png (imagen de fondo), descomenta esto:
        // const stripBuffer = fs.readFileSync(path.join(imagesDir, 'strip.png'));

        // 2. DATOS DEL CLIENTE (Simulados)
        const cliente = {
            id: req.params.clientId,
            nombre: "Nahum Cliente",
            puntos: 500,
            nivel: "VIP"
        };

        // 3. CONSTRUIR EL JSON EN CÓDIGO (Igual que Le Duo)
        const passJson = {
            formatVersion: 1,
            passTypeIdentifier: "pass.com.freshmarket.pachuca", // TU ID DE APPLE
            serialNumber: `FRESH-${cliente.id}`,
            teamIdentifier: "L4P8PF94N6", // TU TEAM ID
            organizationName: "Fresh Market",
            description: "Tarjeta de Lealtad Fresh Market",
            logoText: "Fresh Market",
            foregroundColor: "rgb(255, 255, 255)",
            backgroundColor: "rgb(34, 139, 34)", // Verde Fresh Market
            labelColor: "rgb(200, 255, 200)",

            // Aquí definimos la estructura visual directamente
            storeCard: {
                primaryFields: [
                    {
                        key: "puntos",
                        label: "PUNTOS",
                        value: cliente.puntos,
                        textAlignment: "PKTextAlignmentCenter"
                    }
                ],
                secondaryFields: [
                    {
                        key: "cliente",
                        label: "MIEMBRO",
                        value: cliente.nombre,
                        textAlignment: "PKTextAlignmentCenter"
                    }
                ],
                auxiliaryFields: [
                    {
                        key: "nivel",
                        label: "NIVEL",
                        value: cliente.nivel,
                        textAlignment: "PKTextAlignmentRight"
                    }
                ],
                backFields: [
                    {
                        key: "contacto",
                        label: "Contacto",
                        value: "pedidos@freshmarket.com"
                    }
                ]
            },
            barcode: {
                format: "PKBarcodeFormatQR",
                message: cliente.id,
                messageEncoding: "iso-8859-1",
                altText: `ID: ${cliente.id}`
            }
        };

        // 4. PREPARAR LOS BUFFERS (El secreto de Le Duo)
        const buffers = {
            'pass.json': Buffer.from(JSON.stringify(passJson)),
            'icon.png': iconBuffer,
            'icon@2x.png': iconBuffer, // Usamos la misma para 2x por ahora
            'logo.png': logoBuffer,
            'logo@2x.png': logoBuffer,
        };

        // Si tuvieras strip (fondo), lo agregas así:
        // buffers['strip.png'] = stripBuffer;
        // buffers['strip@2x.png'] = stripBuffer;


        // 5. CREAR LA INSTANCIA (Pasando los buffers directamente)
        const pass = new PKPass(buffers, {
            wwdr,
            signerCert,
            signerKey,
        });

        console.log("Generando Buffer final...");

        // 6. GENERAR Y ENVIAR
        const buffer = await pass.getAsBuffer();

        res.set('Content-Type', 'application/vnd.apple.pkpass');
        res.set('Content-Disposition', 'attachment; filename=fresh-market.pkpass');
        res.send(buffer);

        console.log("✅ ¡Pase generado al estilo Le Duo!");

    } catch (err) {
        console.error("❌ ERROR:", err);
        res.status(500).json({
            error: "Error generando pase",
            mensaje: err.message,
            stack: err.stack
        });
    }
});

module.exports = router;