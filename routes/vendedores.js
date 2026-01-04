const router = require('express').Router();
const Vendedor = require('../models/Vendedor');

// 1. CREAR VENDEDOR
router.post('/', async (req, res) => {
    try {
        const nuevoVendedor = new Vendedor(req.body);
        const vendedorGuardado = await nuevoVendedor.save();
        res.status(201).json(vendedorGuardado);
    } catch (err) {
        res.status(500).json(err);
    }
});

// 2. OBTENER TODOS (Para el Dropdown)
// Solo traemos los activos para que no salgan los que ya renunciaron
router.get('/', async (req, res) => {
    try {
        const vendedores = await Vendedor.find({ activo: true }).sort({ nombre: 1 });
        res.status(200).json(vendedores);
    } catch (err) {
        res.status(500).json(err);
    }
});

// 3. EDITAR / DAR DE BAJA
router.put('/:id', async (req, res) => {
    try {
        const vendedorActualizado = await Vendedor.findByIdAndUpdate(
            req.params.id,
            { $set: req.body },
            { new: true }
        );
        res.status(200).json(vendedorActualizado);
    } catch (err) {
        res.status(500).json(err);
    }
});

module.exports = router;