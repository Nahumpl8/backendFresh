const router = require('express').Router();
const Clientes = require('../models/Clientes');
const { verifyToken } = require('./verifyToken');
const Pedido = require('../models/Pedidos');
const WalletDevice = require('../models/WalletDevice');

// Utilidad para limpiar teléfono
function limpiarTelefono(tel) {
    return tel.replace(/\D/g, '').replace(/^52/, '').trim();
}

// Utilidad para normalizar texto
function normalizarTexto(texto) {
    return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// Crear nuevo cliente
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

// Actualizar cliente
router.put('/:id', async (req, res) => {
    try {
        const updatedClientes = await Clientes.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
        res.status(200).json(updatedClientes);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// Obtener cliente y sus pedidos por teléfono
router.get('/detalle/:telefono', async (req, res) => {
    try {
        const telefono = req.params.telefono;

        const cliente = await Clientes.findOne({
            telefono: { $regex: telefono + '$' }
        });

        if (!cliente) {
            return res.status(404).json({ mensaje: 'Cliente no encontrado.' });
        }

        const pedidos = await Pedido.find({
            telefono: { $regex: telefono + '$' }
        }).sort({ fecha: -1 });

        res.json({ cliente, pedidos });
    } catch (error) {
        console.error('Error al obtener detalle de cliente:', error);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// Eliminar cliente
router.delete('/:id', async (req, res) => {
    try {
        await Clientes.findByIdAndDelete(req.params.id);
        res.status(200).json('Cliente eliminado');
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// Editar cliente
router.put('/edit/:id', async (req, res) => {
    try {
        const updatedClientes = await Clientes.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
        res.status(200).json(updatedClientes);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// Obtener cliente por ID
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

// Buscar cliente por nombre y teléfono
router.post('/buscar', async (req, res) => {
    let { telefono } = req.body;
    if (!telefono) return res.status(400).json({ error: 'Teléfono es requerido.' });

    const telefonoNormalizado = limpiarTelefono(telefono);

    try {
        const cliente = await Clientes.findOne({
            telefono: { $regex: telefonoNormalizado + '$' }
        });

        if (!cliente) return res.status(404).json({ mensaje: 'Cliente no encontrado.' });

        res.status(200).json(cliente);
    } catch (err) {
        console.error('Error al buscar cliente:', err);
        res.status(500).json({ msg: 'Error del servidor', error: err });
    }
});

// Resetear puntos
router.put('/reset-puntos/:telefono', async (req, res) => {
    try {
        const cliente = await Clientes.findOneAndUpdate(
            { telefono: { $regex: req.params.telefono } },
            { $set: { puntos: 0 } },
            { new: true }
        );
        if (!cliente) return res.status(404).json({ mensaje: 'Cliente no encontrado' });
        res.status(200).json({ mensaje: 'Puntos reiniciados', cliente });
    } catch (err) {
        console.error('Error al reiniciar puntos:', err);
        res.status(500).json({ error: 'Error al actualizar puntos' });
    }
});

// Resetear racha
router.put('/reset-racha/:telefono', async (req, res) => {
    try {
        const cliente = await Clientes.findOneAndUpdate(
            { telefono: { $regex: req.params.telefono } },
            { $set: { semanasSeguidas: 0, regaloDisponible: false } },
            { new: true }
        );
        if (!cliente) return res.status(404).json({ mensaje: 'Cliente no encontrado' });
        res.status(200).json({ mensaje: 'Racha reiniciada', cliente });
    } catch (err) {
        console.error('Error al reiniciar racha:', err);
        res.status(500).json({ error: 'Error al actualizar racha' });
    }
});

// Canjear puntos y racha
router.put('/canjear/:telefono', async (req, res) => {
    try {
        const cliente = await Clientes.findOneAndUpdate(
            { telefono: { $regex: req.params.telefono } },
            {
                $set: {
                    puntos: 0,
                    semanasSeguidas: 0,
                    regaloDisponible: false,
                }
            },
            { new: true }
        );
        if (!cliente) return res.status(404).json({ mensaje: 'Cliente no encontrado' });
        res.status(200).json({ mensaje: 'Puntos y racha reiniciados', cliente });
    } catch (err) {
        console.error('Error al canjear:', err);
        res.status(500).json({ error: 'Error al actualizar cliente' });
    }
});

// ====================================================================
// 🚀 OBTENER CLIENTES (OPTIMIZADO Y CORREGIDO)
// Esta es la ÚNICA ruta GET / que debe existir.
// ====================================================================
router.get('/', async (req, res) => {
    try {
        const { page, limit } = req.query;

        // IMPORTANTE: Incluimos 'walletPlatform' para que el dashboard sepa si es Apple o Google
        const campos = 'nombre direccion telefono telefonoSecundario gpsLink puntos sellos hasWallet walletPlatform misDirecciones ultimaSemanaRegistrada premiosPendientes createdAt';

        // MODO 1: PAGINACIÓN (Para la tabla de Clientes)
        if (page && limit) {
            const pageNum = parseInt(page);
            const limitNum = parseInt(limit);
            const skip = (pageNum - 1) * limitNum;

            const clientes = await Clientes.find()
                .select(campos)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean();

            const total = await Clientes.countDocuments();
            // console.log('Clientes encontrados con walletPlatform:', clientes.filter(c => c.walletPlatform).length);

            return res.status(200).json({
                data: clientes,
                totalPages: Math.ceil(total / limitNum),
                currentPage: pageNum,
                totalItems: total
            });
        }

        // MODO 2: SIN PAGINACIÓN (Para el Dashboard de Marketing - Rápido ⚡️)
        let query = Clientes.find().select(campos).sort({ createdAt: -1 });

        if (limit) {
            query.limit(parseInt(limit));
        }

        const clientes = await query.lean();
        res.status(200).json(clientes);

    } catch (err) {
        console.error("Error cargando clientes:", err);
        res.status(500).json({ error: 'Error al obtener clientes.' });
    }
});



// ====================================================================
// 🔄 SINCRONIZAR CLIENTES CON WALLET DEVICES
// Visitar para arreglar datos: /api/clientes/sync-wallets
// ====================================================================
// ====================================================================
// 🔄 SINCRONIZAR WALLETS (VERSIÓN FINAL: APPLE + GOOGLE)
// Visitar: /api/clientes/sync-wallets
// ====================================================================
router.get('/sync-wallets', async (req, res) => {
    try {
        const WalletDevice = require('../models/WalletDevice');
        const GoogleWalletObject = require('../models/GoogleWalletObject'); // <--- IMPORTANTE

        console.log("🔄 Iniciando sincronización TOTAL...");

        let log = [];
        let countApple = 0;
        let countGoogle = 0;

        // 1. SINCRONIZAR APPLE (Desde WalletDevice)
        const appleDevices = await WalletDevice.find({});
        for (const device of appleDevices) {
            const cleanId = device.serialNumber.replace('FRESH-', '').replace('LEDUO-', '');

            const cliente = await Clientes.findByIdAndUpdate(cleanId, {
                hasWallet: true,
                walletPlatform: 'apple'
            }, { new: true });

            if (cliente) {
                // Evitamos duplicados en el log si tiene varios dispositivos
                if (!log.includes(`${cliente.nombre} (Apple)`)) {
                    log.push(`${cliente.nombre} (Apple)`);
                    countApple++;
                }
            }
        }

        // 2. SINCRONIZAR GOOGLE (Desde GoogleWalletObject)
        const googleObjects = await GoogleWalletObject.find({});
        for (const obj of googleObjects) {
            // En GoogleWalletObject guardamos el clienteId directo
            const cleanId = obj.clienteId;

            if (cleanId) {
                const cliente = await Clientes.findByIdAndUpdate(cleanId, {
                    hasWallet: true,
                    walletPlatform: 'google'
                }, { new: true });

                if (cliente) {
                    if (!log.includes(`${cliente.nombre} (Google)`)) {
                        log.push(`${cliente.nombre} (Google)`);
                        countGoogle++;
                    }
                }
            }
        }

        console.log("📊 Resumen Sincronización:", log);

        res.json({
            success: true,
            summary: {
                apple: countApple,
                google: countGoogle,
                total: countApple + countGoogle
            },
            details: log
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// 🔍 BÚSQUEDA OPTIMIZADA
router.get('/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query || query.length < 2) return res.json([]);

        const regex = new RegExp(query.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&"), 'i');

        const clientes = await Clientes.find({
            $or: [
                { nombre: regex },
                { telefono: regex },
                { telefonoSecundario: regex }
            ]
        })
            .select('nombre direccion telefono telefonoSecundario gpsLink puntos sellos hasWallet walletPlatform misDirecciones ultimaSemanaRegistrada premiosPendientes')
            .limit(20)
            .lean();

        // Si ya confías en tu DB (después de usar sync-wallets), puedes quitar este bloque lento
        // y devolver 'clientes' directo. Por seguridad lo dejamos un tiempo más.
        const clientesEnriquecidos = await Promise.all(clientes.map(async (c) => {
            if (c.hasWallet) return c; // Si ya dice true en DB, devolverlo

            const serialNumber = `FRESH-${c._id}`;
            const deviceCount = await WalletDevice.countDocuments({ serialNumber });
            return { ...c, hasWallet: deviceCount > 0 };
        }));

        res.json(clientesEnriquecidos);

    } catch (err) {
        console.error("Error búsqueda:", err);
        res.status(500).json([]);
    }
});

// Agregar dirección extra
router.put('/add-address/:id', async (req, res) => {
    try {
        const { alias, direccion, gpsLink } = req.body;
        if (!direccion) return res.status(400).json("Falta la dirección");

        const clienteActualizado = await Clientes.findByIdAndUpdate(
            req.params.id,
            {
                $push: {
                    misDirecciones: {
                        alias: alias || 'Nueva Dirección',
                        direccion: direccion,
                        gpsLink: gpsLink || ''
                    }
                }
            },
            { new: true }
        );

        res.status(200).json(clienteActualizado);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// Ruta Lite
router.get('/lite', async (req, res) => {
    try {
        const clientes = await Clientes.find()
            .select('_id nombre telefono telefonoSecundario direccion misDirecciones gpsLink');
        res.status(200).json(clientes);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// Inactivos semana
router.get('/inactivos-semana', async (req, res) => {
    try {
        const fechasSemana = [
            'lunes, 22 Diciembre 2025',
            'martes, 23 Diciembre 2025',
            'miércoles, 24 Diciembre 2025',
            'jueves, 25 Diciembre 2025',
            'viernes, 26 Diciembre 2025',
            'sábado, 27 Diciembre 2025',
            'domingo, 28 Diciembre 2025',
        ];
        const pedidosSemana = await Pedido.find({ fecha: { $in: fechasSemana } });
        const telefonosActivos = pedidosSemana.map(p => p.telefono);
        const clientesInactivos = await Clientes.find({ telefono: { $nin: telefonosActivos } });
        res.json(clientesInactivos);
    } catch (error) {
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// Stats
router.get('/stats', async (req, res) => {
    const date = new Date();
    const lastYear = new Date(date.setFullYear(date.getFullYear() - 1));
    try {
        const data = await Clientes.aggregate([
            { $match: { createdAt: { $gte: lastYear } } },
            { $project: { month: { $month: '$createdAt' } } },
            { $group: { _id: '$month', total: { $sum: 1 } } },
        ]);
        res.status(200).json(data);
    } catch (err) {
        res.status(500).json(err);
    }
});

// Filtrados
router.get('/filtered', async (req, res) => {
    try {
        const { filter = 'todos' } = req.query;
        const allClientes = await Clientes.find().select('_id nombre telefono');

        if (filter === 'todos') {
            const clientesConUltimoPedido = await Promise.all(
                allClientes.map(async (cliente) => {
                    const telefonoLimpio = limpiarTelefono(cliente.telefono);
                    const ultimoPedido = await Pedido.findOne({
                        telefono: { $regex: telefonoLimpio + '$' }
                    }).sort({ createdAt: -1 });

                    return {
                        _id: cliente._id,
                        nombre: cliente.nombre,
                        telefono: cliente.telefono,
                        ultimoPedido: ultimoPedido?.createdAt || null
                    };
                })
            );
            return res.status(200).json(clientesConUltimoPedido);
        }

        const ahora = new Date();
        let fechaLimite;
        if (filter === 'sinPedidoSemana') fechaLimite = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000);
        else if (filter === 'sinPedido3Semanas') fechaLimite = new Date(ahora.getTime() - 21 * 24 * 60 * 60 * 1000);
        else return res.status(400).json({ error: 'Filtro no válido.' });

        const clientesFiltrados = await Promise.all(
            allClientes.map(async (cliente) => {
                const telefonoLimpio = limpiarTelefono(cliente.telefono);
                const ultimoPedido = await Pedido.findOne({
                    telefono: { $regex: telefonoLimpio + '$' },
                    createdAt: { $gte: fechaLimite }
                }).sort({ createdAt: -1 });

                if (!ultimoPedido) {
                    const ultimoPedidoHistorico = await Pedido.findOne({
                        telefono: { $regex: telefonoLimpio + '$' }
                    }).sort({ createdAt: -1 });
                    return {
                        _id: cliente._id,
                        nombre: cliente.nombre,
                        telefono: cliente.telefono,
                        ultimoPedido: ultimoPedidoHistorico?.createdAt || null
                    };
                }
                return null;
            })
        );
        res.status(200).json(clientesFiltrados.filter(c => c !== null));

    } catch (err) {
        console.error('Error filtrados:', err);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

module.exports = router;