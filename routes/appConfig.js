const router = require('express').Router();
const AppConfig = require('../models/AppConfig');

// GET config (fechas + regalos)
router.get('/', async (req, res) => {
    try {
        const config = await AppConfig.findOne({ key: 'main' });
        if (!config) {
            return res.json({ fechas: [], regalos: [], despensasListasAt: null });
        }
        res.json({ fechas: config.fechas, regalos: config.regalos, despensasListasAt: config.despensasListasAt || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT actualizar fechas
router.put('/fechas', async (req, res) => {
    try {
        const config = await AppConfig.findOneAndUpdate(
            { key: 'main' },
            { key: 'main', fechas: req.body.fechas || [] },
            { upsert: true, new: true }
        );
        res.json({ fechas: config.fechas, regalos: config.regalos });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT actualizar regalos
router.put('/regalos', async (req, res) => {
    try {
        const config = await AppConfig.findOneAndUpdate(
            { key: 'main' },
            { key: 'main', regalos: req.body.regalos || [] },
            { upsert: true, new: true }
        );
        res.json({ fechas: config.fechas, regalos: config.regalos });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT marcar/desmarcar despensas como listas (oculta el aviso de la tienda antes de tiempo)
router.put('/despensas-listas', async (req, res) => {
    try {
        const listas = req.body.listas === true || req.body.listas === 'true';
        const config = await AppConfig.findOneAndUpdate(
            { key: 'main' },
            { key: 'main', despensasListasAt: listas ? new Date() : null },
            { upsert: true, new: true }
        );
        res.json({ despensasListasAt: config.despensasListasAt || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
