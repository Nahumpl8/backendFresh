const router = require('express').Router();
const Pedido = require('../models/Pedidos');
const { verifyToken, verifyTokenAndAuthorization } = require('./verifyToken');

//CREATE

router.post('/new', async (req, res) => {
    const newPedido = new Pedido(req.body);

    try {
        const savedPedido = await newPedido.save();
        res.status(200).json(savedPedido);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

//UPDATE PRODUCT
router.put('/:id', async (req, res) => {

    try {
        const updatedPedido = await Pedido.findByIdAndUpdate(
            req.params.id,
            {
                $set: req.body
            },
            { new: true }
        );
        res.status(200).json(updatedPedido);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
}
)

//DELETE PRODUCT
router.delete('/:id', async (req, res) => {
    try {
        await Pedido.findByIdAndDelete(req.params.id);
        res.status(200).json('Pedido has been deleted...');
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

//GET pedidos
router.get('/find/:id', async (req, res) => {
    try {
        const pedido = await Pedido.findById(req.params.id);
        res.status(200).json(pedido);

    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

//GET ALL pedidos
router.get('/', async (req, res) => {
    try {
        const pedidos = await Pedido.find();
        res.status(200).json(pedidos);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

//Query de pedidos de lunes a domingo
router.get('/semana', async (req, res) => {
    const today = new Date();
    const monday = new Date(today.setDate(today.getDate() - today.getDay() + 1));
    const sunday = new Date(today.setDate(today.getDate() - today.getDay() + 7));

    const pedidosThisWeek = await Pedido.find({
        createdAt: {
            $gte: monday,
            $lte: sunday
        }
    }).sort({ createdAt: 1 });

    res.json(pedidosThisWeek);
});

router.get('/semanaPasada', async (req, res) => {
    const today = new Date();
    const monday = new Date(today.setDate(today.getDate() - today.getDay() + 1));
    const sunday = new Date(today.setDate(today.getDate() - today.getDay()));

    const lastMonday = new Date(monday);
    lastMonday.setDate(lastMonday.getDate() - 7);

    const lastSunday = new Date(sunday);
    lastSunday.setDate(lastSunday.getDate() - 7);

    const pedidosLastWeek = await Pedido.find({
        createdAt: {
            $gte: lastMonday,
            $lte: lastSunday
        }
    }).sort({ createdAt: 1 });

    res.json(pedidosLastWeek);
});


module.exports = router;