const router = require('express').Router();
const Pedido = require('../models/Pedidos');
const Clientes = require('../models/Clientes');
const { verifyToken, verifyTokenAndAuthorization } = require('./verifyToken');
const notifyPassUpdate = require('../utils/pushApple');
const BASE_URL = process.env.BASE_URL || 'https://backendfresh-production.up.railway.app';

// 🟢 NUEVO: Función para detectar Año-Semana de forma estándar
function getWeekString(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const year = d.getUTCFullYear();
    const weekNo = Math.ceil((((d - new Date(Date.UTC(year, 0, 1))) / 86400000) + 1) / 7);
    return `${year}-${weekNo}`;
}

// (Mantenemos tu función de streak vieja por si acaso, aunque la nueva es mejor)
function getWeekNumber(date) {
    const firstDay = new Date(date.getFullYear(), 0, 1);
    const pastDays = Math.floor((date - firstDay) / 86400000);
    return Math.ceil((pastDays + firstDay.getDay() + 1) / 7);
}

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
// 📊 1. REPORTE DE PROMOTORES (Ruta Nueva)
// ==========================================
router.get('/stats/promotores', async (req, res) => { // 👈 NUEVO BLOQUE
    try {
        const { mes, anio } = req.query;
        const now = new Date();
        const year = anio || now.getFullYear();
        const month = mes || (now.getMonth() + 1);

        const fechaInicio = new Date(year, month - 1, 1);
        const fechaFin = new Date(year, month, 0, 23, 59, 59);

        const reporte = await Pedido.aggregate([
            {
                $match: {
                    createdAt: { $gte: fechaInicio, $lte: fechaFin },
                    vendedor: { $ne: 'Fresh Market' },
                    vendedor: { $exists: true, $ne: null }
                }
            },
            {
                $group: {
                    _id: "$vendedor",
                    ventasTotales: { $sum: 1 },
                    dineroGenerado: { $sum: "$total" },
                    comisionesA_Pagar: { $sum: "$comision" },
                    clientesNuevos: { $sum: { $cond: ["$esClienteNuevo", 1, 0] } }
                }
            }
        ]);
        res.json(reporte);
    } catch (err) {
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

        // 🟢 2. CAMBIO: Buscamos al cliente PRIMERO (para ver su vendedor)
        const cliente = await Clientes.findOne({ telefono: telefono });

        // --- LÓGICA DE PROMOTORES 💰 ---
        let vendedor = 'Fresh Market';
        let comision = 0;
        let esClienteNuevo = false;

        if (cliente && cliente.vendedor) {
            vendedor = cliente.vendedor;
        }

        // Si es venta de un promotor, calculamos comisión
        if (vendedor !== 'Fresh Market') {
            const pedidosAnteriores = await Pedido.countDocuments({ telefono: telefono });
            if (pedidosAnteriores === 0) {
                comision = 20; // Cliente Nuevo
                esClienteNuevo = true;
            } else {
                comision = 10; // Recurrente
                esClienteNuevo = false;
            }
        }

        // Guardamos el pedido con los datos nuevos
        const newPedido = new Pedido({
            ...req.body,
            vendedor,      // 👈 Guardamos quién vendió
            comision,      // 👈 Guardamos cuánto ganó
            esClienteNuevo
        });
        const savedPedido = await newPedido.save();
        console.log("✅ Pedido guardado ID:", savedPedido._id);

        let responsePayload = {
            pedido: savedPedido,
            walletLinks: null
        };

        // 3. Actualizar Cliente
        if (cliente) {
            console.log("👤 Actualizando cliente:", cliente.nombre);

            const totalGastado = (cliente.totalGastado || 0) + req.body.total;
            const totalPedidos = (cliente.totalPedidos || 0) + 1;

            // 🟢 CAMBIO CASHBACK: 1.2%
            const efectivoGastado = req.body.total - (puntosUsados || 0);
            const nuevosPuntos = Math.round(efectivoGastado * 0.012); // 👈 CAMBIADO DE 0.015 A 0.012
            const puntos = (cliente.puntos || 0) - puntosUsados + nuevosPuntos;

            // --- Lógica de Racha (La mantenemos igual) ---
            const now = new Date();
            const semanaActualRacha = `${now.getFullYear()}-${getWeekNumber(now)}`;
            let semanasSeguidas = cliente.semanasSeguidas || 0;

            if (cliente.ultimaSemanaRegistrada === semanaActualRacha) {
                // misma semana
            } else if (esSemanaAnterior(cliente.ultimaSemanaRegistrada, semanaActualRacha)) {
                semanasSeguidas += 1;
            } else {
                semanasSeguidas = 1;
            }
            const regaloDisponible = semanasSeguidas >= 4;

            // 🟢 3. NUEVA LÓGICA DE SELLOS (Compleja)
            const semanaSelloActual = getWeekString(new Date());
            let sellos = cliente.sellos || 0;
            let sellosSemestrales = cliente.sellosSemestrales || 0; // 👈 NUEVO ACUMULADOR
            let tarjetasCompletadas = cliente.tarjetasCompletadas || 0;
            let premioDisponibleWallet = cliente.premioDisponible || false;
            let ultimaSemanaSello = cliente.ultimaSemanaSello || '';

            // Solo damos sello si es una semana DIFERENTE
            if (ultimaSemanaSello !== semanaSelloActual) {

                // Si ya tenía 8 y premio disponible, este es el pedido de CANJE (el noveno)
                if (sellos >= 8) {
                    sellos = 1; // 👈 Reinicia a 1
                    premioDisponibleWallet = false; // 👈 Ya usó su premio
                    tarjetasCompletadas += 1;
                } else {
                    sellos += 1; // Sube normal
                }

                sellosSemestrales += 1; // 👈 Este siempre sube (para Nivel Leyenda)

                // Si llega a 8 exactos, activamos el premio
                if (sellos === 8) {
                    premioDisponibleWallet = true;
                }

                ultimaSemanaSello = semanaSelloActual; // Marcamos que ya pidió esta semana
                console.log(`✅ Sello otorgado. Tarjeta: ${sellos}/8.`);
            } else {
                console.log(`⏳ Mismo pedido en semana ${semanaSelloActual}. No se otorga sello.`);
            }

            await cliente.updateOne({
                $set: {
                    totalGastado,
                    totalPedidos,
                    puntos,
                    semanasSeguidas,
                    regaloDisponible,
                    ultimaSemanaRegistrada: semanaActualRacha,

                    // Campos nuevos de sellos
                    sellos: sellos,
                    sellosSemestrales: sellosSemestrales,
                    premioDisponible: premioDisponibleWallet,
                    ultimaSemanaSello: ultimaSemanaSello,
                    tarjetasCompletadas: tarjetasCompletadas
                }
            });

            // 🔔 NOTIFICACIÓN WALLET
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

// Editar pedido (Sin cambios)
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
            // 🟢 CAMBIO CASHBACK: 1.2% (Reversión)
            const puntosGanados = Math.round((pedido.total - (pedido.puntosUsados || 0)) * 0.012); // 👈 CAMBIADO A 0.012
            const puntosDevueltos = pedido.puntosUsados || 0;
            const nuevosPuntos = (cliente.puntos || 0) - puntosGanados + puntosDevueltos;
            const puntosFinal = nuevosPuntos >= 0 ? nuevosPuntos : 0;

            // Revertir sellos (Simplificado: Restamos 1, aunque no es exacto por fechas)
            const nuevosSellos = (cliente.sellos || 0) - 1;
            const sellosFinal = nuevosSellos >= 0 ? nuevosSellos : 0;

            // Revertir semestrales también
            const nuevosSemestrales = (cliente.sellosSemestrales || 0) - 1;

            await cliente.updateOne({
                $set: {
                    puntos: puntosFinal,
                    sellos: sellosFinal,
                    sellosSemestrales: nuevosSemestrales >= 0 ? nuevosSemestrales : 0, // 👈 Actualizamos este
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

// ... (Resto de tus rutas GET find, cliente, semana, semanaPasada, buscar-fecha se quedan IGUAL) ...
// (Pégalas aquí abajo tal cual las tenías en tu archivo original)

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

router.get('/', async (req, res) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit) : 100;
        const pedidos = await Pedido.find().sort({ createdAt: -1 }).limit(limit);
        res.status(200).json(pedidos);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

router.get('/semana', async (req, res) => {
    const today = new Date();
    const monday = new Date(today.setDate(today.getDate() - today.getDay() + 1));
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(today.setDate(today.getDate() - today.getDay() + 7));
    sunday.setHours(23, 59, 59, 999);
    const pedidosThisWeek = await Pedido.find({ createdAt: { $gte: monday, $lte: sunday } }).sort({ createdAt: -1 });
    res.json(pedidosThisWeek);
});

router.get('/semanaPasada', async (req, res) => {
    const today = new Date();
    const mondayThisWeek = new Date(today.setDate(today.getDate() - today.getDay() + 1));
    const lastSunday = new Date(mondayThisWeek);
    lastSunday.setDate(lastSunday.getDate() - 1);
    lastSunday.setHours(23, 59, 59, 999);
    const lastMonday = new Date(mondayThisWeek);
    lastMonday.setDate(lastMonday.getDate() - 7);
    lastMonday.setHours(0, 0, 0, 0);
    const pedidosLastWeek = await Pedido.find({ createdAt: { $gte: lastMonday, $lte: lastSunday } }).sort({ createdAt: -1 });
    res.json(pedidosLastWeek);
});

router.get('/buscar-fecha', async (req, res) => {
    try {
        const fechaBusqueda = req.query.fecha;
        if (!fechaBusqueda) return res.status(400).json([]);
        const pedidos = await Pedido.find({ fecha: { $regex: fechaBusqueda, $options: 'i' } }).sort({ cliente: 1 });
        res.json(pedidos);
    } catch (err) {
        console.error("Error buscando por fecha:", err);
        res.status(500).json({ error: 'Error al buscar pedidos' });
    }
});

module.exports = router;