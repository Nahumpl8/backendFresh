const router = require('express').Router();
const MarketingCampaign = require('../models/MarketingCampaign');
const WalletDevice = require('../models/WalletDevice');
const notifyPassUpdate = require('../utils/pushApple'); // Tu función maestra

// 1. OBTENER HISTORIAL (Para el Panel)
router.get('/history', async (req, res) => {
    try {
        const campaigns = await MarketingCampaign.find().sort({ sentAt: -1 }).limit(20);
        res.json(campaigns);
    } catch (err) {
        res.status(500).json({ error: 'Error obteniendo historial' });
    }
});

// 2. ENVIAR CAMPAÑA MASIVA
router.post('/send', async (req, res) => {
    const { title, message } = req.body;

    if (!message) return res.status(400).json({ error: "El mensaje es obligatorio" });

    console.log(`🚀 Iniciando campaña: ${title}`);

    // A. Guardamos la campaña PRIMERO
    // (Esto es crucial para que appleService.js pueda leer el mensaje nuevo cuando los iPhones pidan actualización)
    const campaign = await MarketingCampaign.create({
        title,
        message,
        sentAt: new Date()
    });

    // B. Buscamos a quién enviar
    // Estrategia: Buscamos todos los dispositivos registrados en Apple
    // (Tu función notifyPassUpdate ya se encarga de Google si le pasas el ID del cliente)
    try {
        // Obtenemos todos los serialNumbers (que son "FRESH-clientId")
        const devices = await WalletDevice.find({}, 'serialNumber');
        
        // Extraemos los IDs de clientes únicos
        const clientIds = [...new Set(devices.map(d => d.serialNumber.replace('FRESH-', '')))];

        console.log(`📢 Enviando a ${clientIds.length} clientes únicos...`);

        // C. Disparamos las notificaciones en segundo plano
        // No usamos await dentro del map para que sea rápido, pero usamos Promise.allSettled
        // para contar resultados.
        const results = await Promise.allSettled(clientIds.map(clientId => notifyPassUpdate(clientId)));

        // D. Calculamos estadísticas
        const successCount = results.filter(r => r.status === 'fulfilled').length;
        const failedCount = results.filter(r => r.status === 'rejected').length;

        // E. Actualizamos estadísticas en la BD
        campaign.stats = {
            total: clientIds.length,
            success: successCount,
            failed: failedCount
        };
        await campaign.save();

        res.json({ success: true, campaign });

    } catch (err) {
        console.error("❌ Error en campaña masiva:", err);
        res.status(500).json({ error: err.message });
    }
});

// 3. ACTUALIZAR TEXTO GPS (Opcional, si usas la pestaña de Geolocalización)
router.post('/location-text', async (req, res) => {
    // Podrías guardar esto en otra colección de 'Config'
    // Por ahora solo devolvemos éxito para que el front no falle
    res.json({ success: true });
});

module.exports = router;