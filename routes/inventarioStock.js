const router = require('express').Router();
const InventarioStock = require('../models/InventarioStock');

// GET stock por fecha
router.get('/:fecha', async (req, res) => {
    try {
        const doc = await InventarioStock.findOne({ fecha: req.params.fecha });
        if (!doc) {
            return res.json({ fecha: req.params.fecha, stock: {} });
        }
        const stockObj = {};
        doc.stock.forEach((value, key) => {
            stockObj[key] = value;
        });
        res.json({ fecha: doc.fecha, stock: stockObj });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT upsert stock por fecha
router.put('/:fecha', async (req, res) => {
    try {
        const doc = await InventarioStock.findOneAndUpdate(
            { fecha: req.params.fecha },
            { fecha: req.params.fecha, stock: req.body.stock || {} },
            { upsert: true, new: true }
        );
        const stockObj = {};
        doc.stock.forEach((value, key) => {
            stockObj[key] = value;
        });
        res.json({ fecha: doc.fecha, stock: stockObj });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
