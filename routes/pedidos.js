const router = require('express').Router();
const Pedido = require('../models/Pedidos');
const Clientes = require('../models/Clientes');
const { verifyToken, verifyTokenAndAuthorization } = require('./verifyToken');
const notifyPassUpdate = require('../utils/pushApple'); 
const BASE_URL = process.env.BASE_URL || 'https://backendfresh-production.up.railway.app';

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

// ==========================================
// CREAR NUEVO PEDIDO (POST /new)
// ==========================================
router.post('/new', async (req, res) => {
    console.log("📝 Recibiendo nuevo pedido..."); // Log para depurar
    
    try {
        // 1. Guardar el pedido primero
        const newPedido = new Pedido(req.body);
        const savedPedido = await newPedido.save();
        console.log("✅ Pedido guardado ID:", savedPedido._id);

        // 2. Buscar al cliente
        const cliente = await Clientes.findOne({ telefono: req.body.telefono });
        
        let responsePayload = {
            pedido: savedPedido,
            walletLinks: null
        };

        // 3. Actualizar Cliente (si existe)
        if (cliente) {
            console.log("👤 Actualizando cliente:", cliente.nombre);
            
            const puntosUsados = req.body.puntosUsados || 0;
            const totalGastado = (cliente.totalGastado || 0) + req.body.total;
            const totalPedidos = (cliente.totalPedidos || 0) + 1;

            const efectivoGastado = req.body.total - puntosUsados;
            const nuevosPuntos = Math.round(efectivoGastado * 0.015);
            const puntos = (cliente.puntos || 0) - puntosUsados + nuevosPuntos;

            // --- Lógica de Semanas ---
            const now = new Date();
            const semanaActual = `${now.getFullYear()}-${getWeekNumber(now)}`;
            let semanasSeguidas = cliente.semanasSeguidas || 0;

            if (cliente.ultimaSemanaRegistrada === semanaActual) {
                // misma semana, no suma racha
            } else if (esSemanaAnterior(cliente.ultimaSemanaRegistrada, semanaActual)) {
                semanasSeguidas += 1;
            } else {
                semanasSeguidas = 1;
            }

            const regaloDisponible = semanasSeguidas >= 4;

            // --- LÓGICA DE SELLOS ---
            let sellosActuales = cliente.sellos || 0;
            let nuevosSellos = sellosActuales + 1;
            if (nuevosSellos > 8) nuevosSellos = 1; 

            await cliente.updateOne({
                $set: {
                    totalGastado,
                    totalPedidos,
                    puntos,
                    semanasSeguidas,
                    regaloDisponible,
                    ultimaSemanaRegistrada: semanaActual,
                    sellos: nuevosSellos
                }
            });

            // 🔔 NOTIFICACIÓN (No bloqueante)
            notifyPassUpdate(cliente._id).catch(err => console.error("❌ Error push wallet:", err));

            responsePayload.walletLinks = {
                apple: `${BASE_URL}/api/wallet/apple/${cliente._id}`,
                google: `${BASE_URL}/api/wallet/google/${cliente._id}`
            };
        }

        res.status(200).json(responsePayload);

    } catch (err) {
        console.error("❌ Error al crear pedido:", err);
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

        const cliente = await Clientes.findOne({ telefono: pedido.telefono });

        if (cliente) {
            const puntosGanados = Math.round((pedido.total - (pedido.puntosUsados || 0)) * 0.015);
            const puntosDevueltos = pedido.puntosUsados || 0;
            const nuevosPuntos = (cliente.puntos || 0) - puntosGanados + puntosDevueltos;
            const puntosFinal = nuevosPuntos >= 0 ? nuevosPuntos : 0;

            const nuevosSellos = (cliente.sellos || 0) - 1;
            const sellosFinal = nuevosSellos >= 0 ? nuevosSellos : 0;

            await cliente.updateOne({
                $set: {
                    puntos: puntosFinal,
                    sellos: sellosFinal,
                    totalGastado: (cliente.totalGastado || 0) - pedido.total,
                    totalPedidos: (cliente.totalPedidos || 0) - 1
                }
            });
            notifyPassUpdate(cliente._id).catch(err => console.error("❌ Error push wallet delete:", err));
        }

        await Pedido.findByIdAndDelete(req.params.id);
        res.status(200).json('Pedido eliminado.');
    } catch (err) {
        res.status(500).json({ error: 'Error interno al eliminar pedido' });
    }
});

// Obtener un pedido
router.get('/find/:id', async (req, res) => {
    try {
        const pedido = await Pedido.findById(req.params.id);
        res.status(200).json(pedido);
    } catch (err) {
        res.status(500).json(err);
    }
});

// Obtener pedidos por cliente
router.get('/cliente/:telefono', async (req, res) => {
    try {
        const pedidos = await Pedido.find({ telefono: req.params.telefono }).sort({ createdAt: -1 });
        res.status(200).json(pedidos);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener los pedidos.' });
    }
});

// ==========================================
// ⚡️ OBTENER TODOS LOS PEDIDOS (OPTIMIZADO)
// ==========================================
// ANTES: Traía TODO el historial (Lento 🐢)
// AHORA: Trae solo los últimos 100 (Rápido 🐇)
router.get('/', async (req, res) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit) : 100;
        
        const pedidos = await Pedido.find()
            .sort({ createdAt: -1 }) // Los más nuevos primero
            .limit(limit);           // Límite de seguridad
            
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
    monday.setHours(0,0,0,0);
    const sunday = new Date(today.setDate(today.getDate() - today.getDay() + 7));
    sunday.setHours(23,59,59,999);

    const pedidosThisWeek = await Pedido.find({
        createdAt: { $gte: monday, $lte: sunday }
    }).sort({ createdAt: -1 }); // Orden inverso para ver lo último arriba

    res.json(pedidosThisWeek);
});

// Pedidos de la semana pasada
router.get('/semanaPasada', async (req, res) => {
    // ... (Tu lógica de fechas estaba bien, solo asegúrate de ordenarlos)
    const today = new Date();
    // Ajuste simple para obtener lunes pasado
    const mondayThisWeek = new Date(today.setDate(today.getDate() - today.getDay() + 1));
    const lastSunday = new Date(mondayThisWeek);
    lastSunday.setDate(lastSunday.getDate() - 1);
    lastSunday.setHours(23,59,59,999);
    
    const lastMonday = new Date(mondayThisWeek);
    lastMonday.setDate(lastMonday.getDate() - 7);
    lastMonday.setHours(0,0,0,0);

    const pedidosLastWeek = await Pedido.find({
        createdAt: { $gte: lastMonday, $lte: lastSunday }
    }).sort({ createdAt: -1 });

    res.json(pedidosLastWeek);
});

module.exports = router;