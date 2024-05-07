const router = require('express').Router();
const Clientes = require('../models/clientes');
const { verifyToken } = require('./verifyToken');

//add new Clientes
router.post('/new', async (req, res) => {
    const newClientes = new Clientes(req.body);

    try {
        const savedClientes = await newClientes.save();
        res.status(201).json(savedClientes);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

//UPDATE
router.put('/:id', async (req, res) => {

    try {
        const updatedClientes = await Clientes.findByIdAndUpdate(
            req.params.id,
            {
                $set: req.body
            },
            { new: true }
        );
        res.status(200).json(updatedClientes);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
}
)

//DELETE
router.delete('/:id', async (req, res) => {
    try {
        await Clientes.findByIdAndDelete(req.params.id);
        res.status(200).json('Clientes has been deleted...');
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

//Edit Clientes
router.put('/edit/:id', async (req, res) => {
    try {
        const updatedClientes = await Clientes.findByIdAndUpdate(
            req.params.id,
            {
                $set: req.body
            },
            { new: true }
        );
        res.status(200).json(updatedClientes);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

//GET Clientes
router.get('/find/:id', async (req, res) => {
    try {
        const clientes = await Clientes.findById(req.params.id);

        const { password, ...others } = clientes._doc;

        res.status(200).json(others);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

//GET ALL Clientes
router.get('/', async (req, res) => {
    const query = req.query.new;

    try {
        const clientes = query ?
            await Clientes.find().sort({ _id: -1 }).limit(5)
            : await Clientes.find(req.params.id);

        res.status(200).json(clientes);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

//GET Clientes STATS
router.get('/stats', async (req, res) => {
    const date = new Date();
    const lastMonth = new Date(date.setMonth(date.getMonth() - 1));
    const lastYear = new Date(date.setFullYear(date.getFullYear() - 1));

    try {
        const data = await Clientes.aggregate([
            {
                $match: {
                    createdAt: { $gte: lastYear }
                }
            },
            {
                $project: {
                    month: { $month: '$createdAt' }
                },
            },
            {
                $group: {
                    _id: '$month',
                    total: { $sum: 1 }
                }
            }
        ]);

        res.status(200).json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

module.exports = router;