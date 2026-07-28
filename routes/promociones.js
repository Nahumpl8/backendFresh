const router = require('express').Router();
const Promocion = require('../models/Promocion');
const { promosAplicables } = require('../utils/promociones');

// Listar todas (panel admin)
router.get('/', async (req, res) => {
    try {
        const promos = await Promocion.find().sort({ createdAt: -1 });
        res.status(200).json(promos);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// Promos activas que aplicarían a un pedido (sin reclamar cupo) — para mostrar al usuario.
// GET /activas?via=web&fecha=...&telefono=...
router.get('/activas', async (req, res) => {
    try {
        const { via, fecha, telefono } = req.query;
        const promos = await promosAplicables({ via, fecha });
        const conCupo = promos
            .filter(p => !p.limite || p.limite <= 0 || p.usados < p.limite)
            // Si cuenta por cliente y este teléfono ya la reclamó, no la ofrecemos
            .filter(p => !(p.contarPor === 'cliente' && telefono && (p.telefonosReclamados || []).includes(telefono)))
            .map(p => ({
                _id: p._id,
                nombre: p.nombre,
                tipo: p.tipo,
                regalo: p.regalo,
                descuento: p.descuento,
                cupoRestante: p.limite && p.limite > 0 ? Math.max(0, p.limite - p.usados) : null,
            }));
        res.status(200).json(conCupo);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// Crear
router.post('/', async (req, res) => {
    try {
        const nueva = new Promocion(req.body);
        const saved = await nueva.save();
        res.status(201).json(saved);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// Editar / toggle activa / ajustar límite
router.put('/:id', async (req, res) => {
    try {
        const updated = await Promocion.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
        res.status(200).json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// Reiniciar cupo (usados=0 y limpiar teléfonos) — útil para reusar una promo
router.put('/:id/reset', async (req, res) => {
    try {
        const updated = await Promocion.findByIdAndUpdate(
            req.params.id,
            { $set: { usados: 0, telefonosReclamados: [] } },
            { new: true }
        );
        res.status(200).json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// Borrar
router.delete('/:id', async (req, res) => {
    try {
        await Promocion.findByIdAndDelete(req.params.id);
        res.status(200).json('Promoción eliminada');
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

module.exports = router;
