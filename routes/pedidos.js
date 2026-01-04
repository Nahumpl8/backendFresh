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
// 📊 REPORTE DE PROMOTORES (NUEVO)
// GET /api/pedidos/stats/promotores?mes=1&anio=2026
// ==========================================
router.get('/stats/promotores', async (req, res) => {
    try {
        const { mes, anio } = req.query;
        
        // Si no mandan fecha, usamos el mes actual
        const now = new Date();
        const year = anio || now.getFullYear();
        const month = mes || (now.getMonth() + 1);

        const fechaInicio = new Date(year, month - 1, 1);
        const fechaFin = new Date(year, month, 0, 23, 59, 59);

        const reporte = await Pedido.aggregate([
            {
                $match: {
                    createdAt: { $gte: fechaInicio, $lte: fechaFin },
                    vendedor: { $ne: 'Fresh Market' }, // Ignorar ventas directas
                    vendedor: { $exists: true, $ne: null }
                }
            },
            {
                $group: {
                    _id: "$vendedor",
                    ventasTotales: { $sum: 1 },
                    dineroGenerado: { $sum: "$total" },
                    comisionesA_Pagar: { $sum: "$comision" }, // Suma automática de $20 y $10
                    clientesNuevos: { 
                        $sum: { $cond: ["$esClienteNuevo", 1, 0] } 
                    }
                }
            }
        ]);

        res.json(reporte);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// ==========================================
// CREAR NUEVO PEDIDO (POST /new)
// ==========================================
router.post('/new', async (req, res) => {
    console.log("📝 Recibiendo nuevo pedido..."); 
    
    try {
        const { telefono, puntosUsados, total } = req.body;

        // 1. Buscar al cliente ANTES de guardar (Para lógica de promotores)
        const cliente = await Clientes.findOne({ telefono: telefono });
        
        // --- LÓGICA DE PROMOTORES ---
        let vendedor = 'Fresh Market';
        let comision = 0;
        let esClienteNuevo = false;

        if (cliente && cliente.vendedor) {
            vendedor = cliente.vendedor; // "Laura Lopez", etc.
        }

        // Si hay un promotor asignado (que no sea la tienda)
        if (vendedor !== 'Fresh Market') {
            // Contamos cuántos pedidos previos tiene este cliente
            const pedidosAnteriores = await Pedido.countDocuments({ telefono: telefono });

            if (pedidosAnteriores === 0) {
                // PRIMER PEDIDO -> $20
                comision = 20;
                esClienteNuevo = true;
            } else {
                // RECURRENTE -> $10
                comision = 10;
                esClienteNuevo = false;
            }
            console.log(`💰 Comisión para ${vendedor}: $${comision} (Cliente Nuevo: ${esClienteNuevo})`);
        }

        // 2. Guardar el pedido con los datos de comisión
        const newPedido = new Pedido({
            ...req.body,
            vendedor,
            comision,
            esClienteNuevo
        });
        const savedPedido = await newPedido.save();
        console.log("✅ Pedido guardado ID:", savedPedido._id);

        let responsePayload = {
            pedido: savedPedido,
            walletLinks: null
        };

        // 3. Actualizar Cliente (Puntos, Sellos, Racha)
        if (cliente) {
            console.log("👤 Actualizando cliente:", cliente.nombre);
            
            const totalGastado = (cliente.totalGastado || 0) + total;
            const totalPedidos = (cliente.totalPedidos || 0) + 1;

            const efectivoGastado = total - (puntosUsados || 0);
            const nuevosPuntos = Math.round(efectivoGastado * 0.015);
            const puntos = (cliente.puntos || 0) - (puntosUsados || 0) + nuevosPuntos;

            // --- Lógica de Semanas (Racha) ---
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

            // --- LÓGICA DE SELLOS (Ciclo 1-8) ---
            let sellosActuales = cliente.sellos || 0;
            let nuevosSellos = sellosActuales + 1;
            if (nuevosSellos > 8) nuevosSellos = 1; // Reinicia ciclo, pero sigue teniendo sello 1

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

            // 🔔 NOTIFICACIÓN WALLET
            // Usamos notifyPassUpdate que ya maneja Apple y Google automáticamente
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
            // Notificamos la reversión de puntos
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
// ⚡️ OBTENER TODOS LOS PEDIDOS
// ==========================================
router.get('/', async (req, res) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit) : 100;
        
        const pedidos = await Pedido.find()
            .sort({ createdAt: -1 }) 
            .limit(limit);           
            
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
    }).sort({ createdAt: -1 });

    res.json(pedidosThisWeek);
});

// Pedidos de la semana pasada
router.get('/semanaPasada', async (req, res) => {
    const today = new Date();
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


// 🔍 BUSCAR PEDIDOS POR FECHA EXACTA
router.get('/buscar-fecha', async (req, res) => {
    try {
        const fechaBusqueda = req.query.fecha;
        
        if (!fechaBusqueda) {
            return res.status(400).json([]);
        }

        const pedidos = await Pedido.find({ 
            fecha: { $regex: fechaBusqueda, $options: 'i' } 
        }).sort({ cliente: 1 }); 

        res.json(pedidos);

    } catch (err) {
        console.error("Error buscando por fecha:", err);
        res.status(500).json({ error: 'Error al buscar pedidos' });
    }
});


module.exports = router;