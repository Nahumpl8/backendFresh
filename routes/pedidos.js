const router = require('express').Router();
const Pedido = require('../models/Pedidos');
const Clientes = require('../models/Clientes');
// Si no usas verifyToken en estas rutas, puedes comentar la línea siguiente, 
// pero es buena práctica tenerla importada por si acaso.
const { verifyToken, verifyTokenAndAuthorization } = require('./verifyToken');
const notifyPassUpdate = require('../utils/pushApple');
// 👇 IMPORTANTE: Importamos la lógica de notificación de Google
const { notifyGoogleWalletUpdate } = require('../utils/pushGoogle');

const BASE_URL = process.env.BASE_URL || 'https://backendfresh-production.up.railway.app';

// ==========================================
// 📅 HELPER FUNCTIONS (FECHAS Y SEMANAS)
// ==========================================

// 🟢 NUEVO: Función para detectar Año-Semana de forma estándar (ISO)
function getWeekString(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const year = d.getUTCFullYear();
    const weekNo = Math.ceil((((d - new Date(Date.UTC(year, 0, 1))) / 86400000) + 1) / 7);
    return `${year}-${weekNo}`;
}

// (Legacy) Función de streak vieja
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
// 📊 DASHBOARD: Pedidos por rango de fechas
// ==========================================
router.get('/stats/rango', async (req, res) => {
    try {
        const { desde, hasta } = req.query;
        if (!desde || !hasta) {
            return res.status(400).json({ error: 'Se requieren parámetros desde y hasta (YYYY-MM-DD)' });
        }
        const fechaDesde = new Date(desde);
        fechaDesde.setHours(0, 0, 0, 0);
        const fechaHasta = new Date(hasta);
        fechaHasta.setHours(23, 59, 59, 999);

        const pedidos = await Pedido.find({
            createdAt: { $gte: fechaDesde, $lte: fechaHasta }
        }).sort({ createdAt: -1 });

        res.json(pedidos);
    } catch (err) {
        console.error('Error en /stats/rango:', err);
        res.status(500).json(err);
    }
});

// ==========================================
// 📊 DASHBOARD: Resumen semanal (para gráfica)
// ==========================================
router.get('/stats/semanal', async (req, res) => {
    try {
        const semanas = parseInt(req.query.semanas) || 8;
        const resultado = [];

        for (let i = semanas - 1; i >= 0; i--) {
            const now = new Date();
            // Calcular lunes de la semana i semanas atrás
            const dayOfWeek = now.getDay() || 7; // Domingo = 7
            const lunes = new Date(now);
            lunes.setDate(now.getDate() - dayOfWeek + 1 - (i * 7));
            lunes.setHours(0, 0, 0, 0);

            const domingo = new Date(lunes);
            domingo.setDate(lunes.getDate() + 6);
            domingo.setHours(23, 59, 59, 999);

            const pedidos = await Pedido.find({
                createdAt: { $gte: lunes, $lte: domingo }
            });

            const totalVentas = pedidos.reduce((acc, p) => acc + (p.total || 0), 0);
            const totalPedidos = pedidos.length;

            // Formato de nombre: "24 Feb - 2 Mar"
            const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
            const nombre = `${lunes.getDate()} ${meses[lunes.getMonth()]} - ${domingo.getDate()} ${meses[domingo.getMonth()]}`;

            resultado.push({
                name: nombre,
                total: totalVentas,
                pedidos: totalPedidos
            });
        }

        res.json(resultado);
    } catch (err) {
        console.error('Error en /stats/semanal:', err);
        res.status(500).json(err);
    }
});

// ==========================================
// 📊 1. REPORTE DE PROMOTORES (Analytics)
// ==========================================
router.get('/stats/promotores', async (req, res) => {
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
// 📝 2. CREAR NUEVO PEDIDO (Logica Completa)
// ==========================================
router.post('/new', async (req, res) => {
    console.log("📝 Recibiendo nuevo pedido...");

    try {
        const { telefono, puntosUsados, total } = req.body;

        // Buscar al cliente para ver su vendedor
        const cliente = await Clientes.findOne({ telefono: telefono });

        // --- LÓGICA DE PROMOTORES ---
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
                comision = 20; // Comisión Cliente Nuevo
                esClienteNuevo = true;
            } else {
                comision = 10; // Comisión Recurrente
                esClienteNuevo = false;
            }
        }

        // Crear objeto del pedido
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

        // --- ACTUALIZACIÓN DE CLIENTE (Puntos y Sellos) ---
        if (cliente) {
            console.log("👤 Actualizando cliente:", cliente.nombre);

            const totalGastado = (cliente.totalGastado || 0) + req.body.total;
            const totalPedidos = (cliente.totalPedidos || 0) + 1;

            // 1. CASHBACK: 1.2%
            const efectivoGastado = req.body.total - (puntosUsados || 0);
            const nuevosPuntos = Math.round(efectivoGastado * 0.012); 
            const puntos = (cliente.puntos || 0) - puntosUsados + nuevosPuntos;

            // 2. LÓGICA DE RACHA (Semanas seguidas)
            const now = new Date();
            const semanaActualRacha = `${now.getFullYear()}-${getWeekNumber(now)}`;
            let semanasSeguidas = cliente.semanasSeguidas || 0;

            if (cliente.ultimaSemanaRegistrada === semanaActualRacha) {
                // Misma semana, no aumenta racha
            } else if (esSemanaAnterior(cliente.ultimaSemanaRegistrada, semanaActualRacha)) {
                semanasSeguidas += 1;
            } else {
                semanasSeguidas = 1; // Rompió racha
            }
            const regaloDisponible = semanasSeguidas >= 4;

            // 3. LÓGICA DE SELLOS (Wallet)
            const semanaSelloActual = getWeekString(new Date());
            let sellos = cliente.sellos || 0;
            let sellosSemestrales = cliente.sellosSemestrales || 0; 
            let tarjetasCompletadas = cliente.tarjetasCompletadas || 0;
            let premioDisponibleWallet = cliente.premioDisponible || false;
            let ultimaSemanaSello = cliente.ultimaSemanaSello || '';

            // Solo damos sello si es una semana DIFERENTE a la última registrada
            if (ultimaSemanaSello !== semanaSelloActual) {
                // Si ya tenía 8 y premio disponible, asumimos que este pedido es el canje o el inicio de una nueva tarjeta
                if (sellos >= 8) {
                    sellos = 1; // Reinicia la tarjeta
                    premioDisponibleWallet = false; // Se consume el premio anterior
                    tarjetasCompletadas += 1;
                } else {
                    sellos += 1; // Aumenta sello
                }

                sellosSemestrales += 1; // Acumulador histórico (para niveles)

                // Si llega a 8 exactos, activamos el premio
                if (sellos === 8) {
                    premioDisponibleWallet = true;
                }

                ultimaSemanaSello = semanaSelloActual;
                console.log(`✅ Sello otorgado. Tarjeta actual: ${sellos}/8.`);
            } else {
                console.log(`⏳ Mismo pedido en semana ${semanaSelloActual}. No se otorga sello.`);
            }

            // Guardar cambios en Cliente
            await cliente.updateOne({
                $set: {
                    totalGastado,
                    totalPedidos,
                    puntos,
                    semanasSeguidas,
                    regaloDisponible,
                    ultimaSemanaRegistrada: semanaActualRacha,
                    // Wallet fields
                    sellos,
                    sellosSemestrales,
                    premioDisponible: premioDisponibleWallet,
                    ultimaSemanaSello,
                    tarjetasCompletadas
                }
            });

            // ---------------------------------------------
            // 🚀 AUTOMATIZACIÓN DE WALLETS (EL TRIGGER)
            // ---------------------------------------------
            
            // 1. Notificar a Apple (Ya lo tenías)
            notifyPassUpdate(cliente._id).catch(err => console.error("❌ Error push apple:", err));

            // 2. Notificar a Google (NUEVO) — await para capturar resultado
            if (cliente.hasWallet && (cliente.walletPlatform === 'google' || cliente.walletPlatform === 'both')) {
                console.log(`🤖 Trigger: Actualizando Google Wallet para ${cliente.nombre}...`);
                try {
                    const ok = await notifyGoogleWalletUpdate(cliente._id);
                    if (!ok) console.warn(`⚠️ notifyGoogleWalletUpdate devolvió false para cliente ${cliente._id}`);
                } catch (err) {
                    console.error("❌ Error push google:", err);
                }
            }
            // ---------------------------------------------

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

// ==========================================
// RUTAS CRUD ESTÁNDAR
// ==========================================

// EDITAR PEDIDO
router.put('/:id', async (req, res) => {
    try {
        const updatedPedido = await Pedido.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
        res.status(200).json(updatedPedido);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// ELIMINAR PEDIDO (Reversión de puntos/sellos)
router.delete('/:id', async (req, res) => {
    try {
        const pedido = await Pedido.findById(req.params.id);
        if (!pedido) return res.status(404).json('Pedido no encontrado');

        const cliente = await Clientes.findOne({ telefono: pedido.telefono });

        if (cliente) {
            // Revertir Puntos (1.2%)
            const puntosGanados = Math.round((pedido.total - (pedido.puntosUsados || 0)) * 0.012); 
            const puntosDevueltos = pedido.puntosUsados || 0;
            const nuevosPuntos = (cliente.puntos || 0) - puntosGanados + puntosDevueltos;
            const puntosFinal = nuevosPuntos >= 0 ? nuevosPuntos : 0;

            // Revertir Sellos (Aproximación simple: resta 1)
            const nuevosSellos = (cliente.sellos || 0) - 1;
            const sellosFinal = nuevosSellos >= 0 ? nuevosSellos : 0;
            const nuevosSemestrales = (cliente.sellosSemestrales || 0) - 1;

            await cliente.updateOne({
                $set: {
                    puntos: puntosFinal,
                    sellos: sellosFinal,
                    sellosSemestrales: nuevosSemestrales >= 0 ? nuevosSemestrales : 0,
                    totalGastado: (cliente.totalGastado || 0) - pedido.total,
                    totalPedidos: (cliente.totalPedidos || 0) - 1
                }
            });
            
            // Notificar reversión a Apple
            notifyPassUpdate(cliente._id).catch(err => console.error("❌ Error push apple delete:", err));

            // Notificar reversión a Google (NUEVO) — await para capturar resultado
            if (cliente.hasWallet && (cliente.walletPlatform === 'google' || cliente.walletPlatform === 'both')) {
                console.log(`🤖 Trigger Delete: Actualizando Google Wallet para ${cliente.nombre}...`);
                try {
                    const ok = await notifyGoogleWalletUpdate(cliente._id);
                    if (!ok) console.warn(`⚠️ notifyGoogleWalletUpdate (delete) devolvió false para cliente ${cliente._id}`);
                } catch (err) {
                    console.error("❌ Error push google delete:", err);
                }
            }
        }

        await Pedido.findByIdAndDelete(req.params.id);
        res.status(200).json('Pedido eliminado.');
    } catch (err) {
        res.status(500).json({ error: 'Error interno al eliminar pedido' });
    }
});

// OBTENER UN PEDIDO POR ID
router.get('/find/:id', async (req, res) => {
    try {
        const pedido = await Pedido.findById(req.params.id);
        res.status(200).json(pedido);
    } catch (err) {
        res.status(500).json(err);
    }
});

// OBTENER PEDIDOS POR CLIENTE
router.get('/cliente/:telefono', async (req, res) => {
    try {
        const pedidos = await Pedido.find({ telefono: req.params.telefono }).sort({ createdAt: -1 });
        res.status(200).json(pedidos);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener los pedidos.' });
    }
});

// ==========================================
// 🚀 RUTAS DE BÚSQUEDA Y FILTRADO (SOLUCIÓN PDF)
// ==========================================

// GET /api/pedidos (TODOS o FILTRADOS POR FECHA)
router.get('/', async (req, res) => {
    try {
        const { fecha, limit } = req.query;
        let query = {};
        let options = { sort: { createdAt: -1 } };

        // 1. Si hay límite, lo aplicamos
        if (limit) {
            options.limit = parseInt(limit);
        }

        // 2. Si hay FECHA (para el PDF), filtramos aquí en el servidor
        if (fecha) {
            query.fecha = { $regex: fecha.trim(), $options: 'i' };
            delete options.limit; 
        }

        const pedidos = await Pedido.find(query, null, options);
        res.status(200).json(pedidos);

    } catch (err) {
        console.error("Error al obtener pedidos:", err);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// OBTENER PEDIDOS DE ESTA SEMANA
router.get('/semana', async (req, res) => {
    try {
        const today = new Date();
        const monday = new Date(today.setDate(today.getDate() - today.getDay() + 1));
        monday.setHours(0, 0, 0, 0);
        const sunday = new Date(today.setDate(today.getDate() - today.getDay() + 7));
        sunday.setHours(23, 59, 59, 999);
        const pedidosThisWeek = await Pedido.find({ createdAt: { $gte: monday, $lte: sunday } }).sort({ createdAt: -1 });
        res.json(pedidosThisWeek);
    } catch (err) {
        res.status(500).json(err);
    }
});

// OBTENER PEDIDOS DE LA SEMANA PASADA
router.get('/semanaPasada', async (req, res) => {
    try {
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
    } catch (err) {
        res.status(500).json(err);
    }
});

// RUTA DE BÚSQUEDA ESPECÍFICA (LEGACY O ALIAS)
router.get('/buscar-fecha', async (req, res) => {
    try {
        const fechaBusqueda = req.query.fecha;
        if (!fechaBusqueda) return res.status(400).json([]);
        
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