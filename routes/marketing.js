const router = require('express').Router();
const MarketingCampaign = require('../models/MarketingCampaign');
const WalletDevice = require('../models/WalletDevice');
const Config = require('../models/Config'); // 👈 IMPORTANTE: Para guardar el GPS
const notifyPassUpdate = require('../utils/pushApple'); 

// 1. OBTENER HISTORIAL
router.get('/history', async (req, res) => {
    try {
        const campaigns = await MarketingCampaign.find().sort({ sentAt: -1 }).limit(20);
        res.json(campaigns);
    } catch (err) {
        res.status(500).json({ error: 'Error obteniendo historial' });
    }
});

// 2. ENVIAR CAMPAÑA (INTELIGENTE 🧠)
router.post('/send', async (req, res) => {
    // Recibimos title, message Y la lista de destinatarios (clientIds)
    const { title, message, clientIds, summary } = req.body;

    if (!message) return res.status(400).json({ error: "El mensaje es obligatorio" });

    // Si el frontend ya hizo el trabajo sucio (notify-bulk) y solo nos manda el resumen,
    // solo guardamos el historial y salimos. Evitamos doble notificación.
    if (summary) {
        console.log(`📝 Guardando historial de campaña ya enviada: ${title}`);
        const campaign = await MarketingCampaign.create({
            title,
            message,
            sentAt: new Date(),
            stats: summary
        });
        return res.json({ success: true, campaign });
    }

    // --- SI LLEGAMOS AQUÍ, ES PORQUE EL BACKEND DEBE ENVIAR LAS NOTIFICACIONES ---
    
    console.log(`🚀 Iniciando campaña Backend: ${title}`);

    // A. Guardamos la campaña PRIMERO (Para que appleService la lea)
    const campaign = await MarketingCampaign.create({
        title,
        message,
        sentAt: new Date()
    });

    try {
        let targets = [];

        // B. Definir a quién enviamos
        if (clientIds && Array.isArray(clientIds) && clientIds.length > 0) {
            // Opción 1: El frontend nos dijo a quién (Filtros: Nuevos, Leales, etc.)
            console.log(`🎯 Enviando a lista filtrada de ${clientIds.length} clientes.`);
            targets = clientIds;
        } else {
            // Opción 2: Enviar a TODOS (Broadcast)
            console.log(`📢 Enviando a TODOS los dispositivos.`);
            const devices = await WalletDevice.find({}, 'serialNumber');
            targets = [...new Set(devices.map(d => d.serialNumber.replace('FRESH-', '')))];
        }

        // C. Disparar notificaciones
        const results = await Promise.allSettled(targets.map(id => notifyPassUpdate(id)));

        // D. Estadísticas
        const successCount = results.filter(r => r.status === 'fulfilled').length;
        const failedCount = results.filter(r => r.status === 'rejected').length;

        // E. Actualizar historial
        campaign.stats = {
            total: targets.length,
            success: successCount,
            failed: failedCount
        };
        await campaign.save();

        res.json({ success: true, campaign });

    } catch (err) {
        console.error("❌ Error en campaña:", err);
        res.status(500).json({ error: err.message });
    }
});

// 3. ACTUALIZAR TEXTO GPS (AHORA SÍ GUARDA 💾)
router.post('/location-text', async (req, res) => {
    try {
        const { text } = req.body;
        
        if (!text) return res.status(400).json({ error: "Texto requerido" });

        // Guardamos en la colección Config para que appleService.js lo lea
        await Config.findOneAndUpdate(
            { key: 'gps_message' },
            { value: text, updatedAt: new Date() },
            { upsert: true, new: true }
        );

        console.log(`📍 Mensaje GPS actualizado a: "${text}"`);
        res.json({ success: true, message: 'Ubicación actualizada correctamente' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error guardando configuración GPS' });
    }
});

module.exports = router;