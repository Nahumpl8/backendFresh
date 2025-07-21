const router = require('express').Router();
const Pedido = require('../models/Pedidos');
const Clientes = require('../models/Clientes');
const { verifyToken, verifyTokenAndAuthorization } = require('./verifyToken');

// Función para obtener el número de semana del año
function getWeekNumber(date) {
    const firstDay = new Date(date.getFullYear(), 0, 1);
    const pastDays = Math.floor((date - firstDay) / 86400000);
    return Math.ceil((pastDays + firstDay.getDay() + 1) / 7);
}

// Verifica si una semana es la anterior a otra
function esSemanaAnterior(anterior, actual) {
    if (!anterior || !actual) return false;

    const [anio1, semana1] = anterior.split('-').map(Number);
    const [anio2, semana2] = actual.split('-').map(Number);

    return (
        (anio1 === anio2 && semana2 === semana1 + 1) ||
        (anio2 === anio1 + 1 && semana1 >= 52 && semana2 === 1)
    );
}

// Crear nuevo pedido
router.post('/new', async (req, res) => {
    const newPedido = new Pedido(req.body);

    try {
        const savedPedido = await newPedido.save();

        const cliente = await Clientes.findOne({ telefono: req.body.telefono });
        if (cliente) {
            const puntosUsados = req.body.puntosUsados || 0;
            const totalGastado = (cliente.totalGastado || 0) + req.body.total;
            const totalPedidos = (cliente.totalPedidos || 0) + 1;

            const efectivoGastado = req.body.total - puntosUsados;
            const nuevosPuntos = Math.round(efectivoGastado * 0.015);
            const puntos = (cliente.puntos || 0) - puntosUsados + nuevosPuntos;

            const now = new Date();
            const semanaActual = `${now.getFullYear()}-${getWeekNumber(now)}`;
            let semanasSeguidas = cliente.semanasSeguidas || 0;

            if (cliente.ultimaSemanaRegistrada === semanaActual) {
                // misma semana, no cambia
            } else if (esSemanaAnterior(cliente.ultimaSemanaRegistrada, semanaActual)) {
                semanasSeguidas += 1;
            } else {
                semanasSeguidas = 1;
            }

            const regaloDisponible = semanasSeguidas >= 4;

            await cliente.updateOne({
                $set: {
                    totalGastado,
                    totalPedidos,
                    puntos,
                    semanasSeguidas,
                    regaloDisponible,
                    ultimaSemanaRegistrada: semanaActual
                }
            });
        }

        res.status(200).json(savedPedido);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// Editar pedido
router.put('/:id', async (req, res) => {
    try {
        const updatedPedido = await Pedido.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
        res.status(200).json(updatedPedido);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// Eliminar pedido
router.delete('/:id', async (req, res) => {
    try {
        const pedido = await Pedido.findById(req.params.id);
        if (!pedido) return res.status(404).json('Pedido no encontrado');

        console.log('Pedido a eliminar:', pedido); // Verifica que puntosUsados esté presente

        const cliente = await Clientes.findOne({ telefono: pedido.telefono });

        if (cliente) {
            const puntosGanados = Math.round((pedido.total - (pedido.puntosUsados || 0)) * 0.015);
            const puntosDevueltos = pedido.puntosUsados || 0;

            const nuevosPuntos =
                (cliente.puntos || 0) - puntosGanados + puntosDevueltos;

            // Evitar negativos
            const puntosFinal = nuevosPuntos >= 0 ? nuevosPuntos : 0;

            await cliente.updateOne({
                $set: {
                    puntos: puntosFinal,
                    totalGastado: (cliente.totalGastado || 0) - pedido.total,
                    totalPedidos: (cliente.totalPedidos || 0) - 1
                }
            });

            console.log(`Cliente actualizado: -${puntosGanados} puntos ganados, +${puntosDevueltos} puntos devueltos`);
        }

        await Pedido.findByIdAndDelete(req.params.id);

        res.status(200).json('Pedido eliminado y puntos actualizados correctamente');
    } catch (err) {
        console.error('Error al eliminar pedido:', err);
        res.status(500).json({ error: 'Error interno al eliminar pedido' });
    }
});

// Obtener un pedido
router.get('/find/:id', async (req, res) => {
    try {
        const pedido = await Pedido.findById(req.params.id);
        res.status(200).json(pedido);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// Obtener pedidos por cliente
router.get('/cliente/:telefono', async (req, res) => {
    try {
        const pedidos = await Pedido.find({ telefono: req.params.telefono }).sort({ createdAt: -1 });
        res.status(200).json(pedidos);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al obtener los pedidos.' });
    }
});

// Obtener todos los pedidos
router.get('/', async (req, res) => {
    try {
        const pedidos = await Pedido.find();
        res.status(200).json(pedidos);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Pedidos de esta semana
router.get('/semana', async (req, res) => {
    const today = new Date();
    const monday = new Date(today.setDate(today.getDate() - today.getDay() + 1));
    const sunday = new Date(today.setDate(today.getDate() - today.getDay() + 7));

    const pedidosThisWeek = await Pedido.find({
        createdAt: { $gte: monday, $lte: sunday }
    }).sort({ createdAt: 1 });

    res.json(pedidosThisWeek);
});

// Pedidos de la semana pasada
router.get('/semanaPasada', async (req, res) => {
    const today = new Date();
    const monday = new Date(today.setDate(today.getDate() - today.getDay() + 1));
    const sunday = new Date(today.setDate(today.getDate() - today.getDay()));

    const lastMonday = new Date(monday);
    lastMonday.setDate(lastMonday.getDate() - 7);

    const lastSunday = new Date(sunday);
    lastSunday.setDate(lastSunday.getDate() - 7);

    const pedidosLastWeek = await Pedido.find({
        createdAt: { $gte: lastMonday, $lte: lastSunday }
    }).sort({ createdAt: 1 });

    res.json(pedidosLastWeek);
});

module.exports = router;