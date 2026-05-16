const router = require('express').Router();
const Repartidor = require('../models/Repartidor');
const { requireAdmin } = require('../utils/adminMiddleware');

// Listar (público para el selector del repartidor)
router.get('/', async (req, res) => {
    try {
        const lista = await Repartidor.find().sort({ nombre: 1 });
        res.json(lista);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Crear (admin)
router.post('/', requireAdmin, async (req, res) => {
    try {
        const { nombre, telefono } = req.body;
        if (!nombre || !telefono) {
            return res.status(400).json({ error: 'Nombre y teléfono requeridos' });
        }
        const nuevo = await Repartidor.create({ nombre, telefono });
        res.status(201).json(nuevo);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ error: 'Ya existe un repartidor con ese teléfono' });
        }
        res.status(500).json({ error: err.message });
    }
});

// Editar / activar / desactivar (admin)
router.patch('/:id', requireAdmin, async (req, res) => {
    try {
        const actualizado = await Repartidor.findByIdAndUpdate(
            req.params.id,
            { $set: req.body },
            { new: true }
        );
        if (!actualizado) return res.status(404).json({ error: 'No encontrado' });
        res.json(actualizado);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
