const router = require('express').Router();
const Despensas = require('../models/Despensas');

// CREATE despensa
router.post('/', async (req, res) => {
    const newDespensa = new Despensas(req.body);

    try {
        const savedDespensa = await newDespensa.save();
        res.status(200).json(savedDespensa);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// UPDATE despensa
router.put('/:id', async (req, res) => {
    try {
        const updatedDespensa = await Despensas.findByIdAndUpdate(
            req.params.id,
            { $set: req.body },
            { new: true }
        );
        res.status(200).json(updatedDespensa);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// DELETE despensa
router.delete('/:id', async (req, res) => {
    try {
        await Despensas.findByIdAndDelete(req.params.id);
        res.status(200).json('Despensa has been deleted...');
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// GET despensa by ID
router.get('/find/:id', async (req, res) => {
    try {
        const despensa = await Despensas.findById(req.params.id);
        res.status(200).json(despensa);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// GET ALL despensas
router.get('/', async (req, res) => {
    try {
        const despensas = await Despensas.find();
        res.status(200).json(despensas);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

module.exports = router;
