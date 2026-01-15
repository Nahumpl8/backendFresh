const router = require('express').Router();
const Clientes = require('../models/Clientes');
const EmailCampaign = require('../models/EmailCampaign');
// 👇 Solo necesitamos importar la SMART (la genérica ya no la usaremos aquí)
const { sendSmartEmail } = require('../utils/emailService'); 

// 1. OBTENER HISTORIAL DE CAMPAÑAS
router.get('/email/history', async (req, res) => {
    try {
        const campaigns = await EmailCampaign.find().sort({ createdAt: -1 }).limit(20);
        res.json(campaigns);
    } catch (err) {
        res.status(500).json(err);
    }
});

// 2. ENVIAR CORREO DE PRUEBA (ACTUALIZADO PARA SMART EMAIL)
router.post('/email/test', async (req, res) => {
    // 👇 Recibimos todos los datos visuales para probarlos
    const { email, subject, body, bannerUrl, logoUrl, resources } = req.body;
    
    try {
        // Creamos un "Usuario Falso" para que veas cómo se reemplazan las variables
        const dummyUser = { 
            email, 
            nombre: 'Administrador', // Para que veas "Hola Administrador"
            puntos: 150,             // Para probar {{puntos}}
            sellos: 4                // Para probar {{sellos}}
        };

        const opciones = { 
            bannerUrl, 
            logoUrl, 
            resources, 
            ctaText: 'Ver Botón Prueba', 
            ctaLink: '#' 
        };
        
        // Usamos la función inteligente
        await sendSmartEmail(dummyUser, subject, body, opciones);
        
        res.status(200).json({ message: 'Prueba enviada con éxito' });
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// 3. ENVIAR CAMPAÑA MASIVA (Bulk)
router.post('/email/send-bulk', async (req, res) => {
    // 👇 Agregamos 'logoUrl' que faltaba recibir
    const { subject, body, target, ctaLink, ctaText, bannerUrl, logoUrl, specificEmails, resources } = req.body;

    try {
        console.log(`🚀 Iniciando campaña Smart: ${subject}`);

        let targets = [];

        // IMPORTANTE: Traer puntos y sellos para las fórmulas matemáticas
        const fieldsToSelect = 'nombre email puntos sellos'; 

        if (specificEmails && specificEmails.length > 0) {
            targets = await Clientes.find({ email: { $in: specificEmails } }).select(fieldsToSelect);
        } else {
            let query = { email: { $exists: true, $ne: null } };
            targets = await Clientes.find(query).select(fieldsToSelect);
        }

        if (targets.length === 0) return res.status(400).json({ message: "Sin destinatarios." });

        // Guardar en historial
        const newCampaign = new EmailCampaign({
            subject, body, target: target || 'manual', recipientCount: targets.length, status: 'sending'
        });
        await newCampaign.save();

        res.json({ message: `Enviando a ${targets.length} clientes...` });

        // Opciones visuales (Agregamos logoUrl aquí también)
        const opciones = { ctaLink, ctaText, bannerUrl, logoUrl, resources };

        // ENVÍO EN SEGUNDO PLANO
        sendBulkBackground(targets, subject, body, opciones);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error iniciando campaña' });
    }
});

// 👇 ESTA ES LA ÚNICA FUNCIÓN QUE DEBE EXISTIR (Borré la duplicada vieja)
async function sendBulkBackground(users, subject, body, opciones) {
    let successCount = 0;
    
    for (const user of users) {
        if (!user.email || !user.email.includes('@')) continue;
        
        // Pausa para no saturar (Rate Limit)
        await new Promise(r => setTimeout(r, 400)); 

        try {
            // Usamos sendSmartEmail pasando el usuario completo
            const sent = await sendSmartEmail(user, subject, body, opciones);
            if (sent) successCount++;
        } catch (error) {
            console.error(`Error enviando a ${user.email}`);
        }
    }
    console.log(`✅ Campaña Smart terminada: ${successCount} enviados.`);
}

module.exports = router;