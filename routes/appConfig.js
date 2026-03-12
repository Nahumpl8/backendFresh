const router = require('express').Router();
const AppConfig = require('../models/AppConfig');

// GET config (fechas + regalos)
router.get('/', async (req, res) => {
    try {
        const config = await AppConfig.findOne({ key: 'main' });
        if (!config) {
            return res.json({ fechas: [], regalos: [] });
        }
        res.json({ fechas: config.fechas, regalos: config.regalos });
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

module.exports = router;
