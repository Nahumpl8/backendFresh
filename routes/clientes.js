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
// 🚀 OBTENER CLIENTES (VERSIÓN HÍBRIDA / AUTO-REPARABLE)
// ====================================================================
router.get('/', async (req, res) => {
    try {
        const { page, limit } = req.query;
        const WalletDevice = require('../models/WalletDevice'); // Importamos modelo
        
        // 1. CONFIGURAR LA CONSULTA DE CLIENTES
        const campos = 'nombre direccion telefono telefonoSecundario gpsLink puntos sellos hasWallet walletPlatform misDirecciones ultimaSemanaRegistrada premiosPendientes createdAt';
        let query = Clientes.find().select(campos).sort({ createdAt: -1 });

        // Paginación o Límite
        if (page && limit) {
             const skip = (parseInt(page) - 1) * parseInt(limit);
             query.skip(skip).limit(parseInt(limit));
        } else if (limit) {
            query.limit(parseInt(limit));
        }

        // 2. OBTENER CLIENTES (RÁPIDO)
        const clientes = await query.lean();

        // 3. EL TRUCO MAESTRO: TRAER LOS WALLETS ACTIVOS 🎩
        // Traemos solo los serialNumbers de WalletDevice (es una consulta ultra ligera)
        // Esto nos dice: "¿Quiénes tienen Apple Wallet realmente?"
        const walletDevices = await WalletDevice.find({}, 'serialNumber').lean();
        
        // Creamos un "Set" para búsqueda instantánea (O(1))
        // Convertimos 'FRESH-663a...' a '663a...' para comparar fácil
        const idsConApple = new Set(walletDevices.map(d => 
            d.serialNumber.replace('FRESH-', '').replace('LEDUO-', '')
        ));

        // 4. FUSIÓN DE DATOS (EN MEMORIA)
        // Recorremos los clientes y si encontramos uno que está en la lista de Apple,
        // le forzamos los datos correctos, aunque la DB de Clientes diga lo contrario.
        const clientesCorregidos = clientes.map(cliente => {
            const idString = cliente._id.toString();
            
            // ¿Está en la lista real de dispositivos Apple?
            const tieneAppleReal = idsConApple.has(idString);
            
            if (tieneAppleReal) {
                // CASO: Tiene Apple pero la DB no lo sabía o decía Google
                if (!cliente.hasWallet) {
                    return { ...cliente, hasWallet: true, walletPlatform: 'apple' };
                }
                // CASO: Tiene Apple pero está marcado como solo Google (Dual user)
                if (cliente.walletPlatform === 'google') {
                    return { ...cliente, hasWallet: true, walletPlatform: 'both' };
                }
                // Si ya dice apple, lo dejamos así
                if (!cliente.walletPlatform) {
                     return { ...cliente, hasWallet: true, walletPlatform: 'apple' };
                }
            }
            
            // Si no hay cambios, devolvemos el cliente original
            return cliente;
        });

        // 5. RESPONDER
        if (page && limit) {
             const total = await Clientes.countDocuments();
             return res.status(200).json({
                data: clientesCorregidos, // Enviamos la lista corregida
                totalPages: Math.ceil(total / parseInt(limit)),
                currentPage: parseInt(page),
                totalItems: total
            });
        }

        res.status(200).json(clientesCorregidos);

    } catch (err) {
        console.error("Error cargando clientes:", err);
        res.status(500).json({ error: 'Error al obtener clientes.' });
    }
});

// ---------------------------------------------------------
// 🕵️‍♂️ DIAGNÓSTICO DE UN CLIENTE (Para ver por qué falla)
// GET /api/clientes/diagnostico?nombre=Porfirio
// ---------------------------------------------------------
router.get('/diagnostico', async (req, res) => {
    try {
        const { nombre } = req.query;
        // Busca un cliente que coincida con el nombre
        const cliente = await Clientes.findOne({ nombre: { $regex: nombre, $options: 'i' } });
        
        if (!cliente) return res.json({ error: "No encontrado" });

        res.json({
            id: cliente._id,
            nombre: cliente.nombre,
            hasWallet: cliente.hasWallet,       // ¿Qué dice la DB?
            walletPlatform: cliente.walletPlatform, // ¿Qué plataforma tiene?
            sellos: cliente.sellos
        });
    } catch (err) {
        res.json(err);
    }
});

// ---------------------------------------------------------
// 🔄 SINCRONIZAR WALLETS (CORREGIDO "BOTH")
// ---------------------------------------------------------
router.get('/sync-wallets', async (req, res) => {
    try {
        const WalletDevice = require('../models/WalletDevice');
        const GoogleWalletObject = require('../models/GoogleWalletObject');

        console.log("🔄 Sincronizando Wallets...");
        let log = [];

        // 1. APPLE
        const appleDevices = await WalletDevice.find({});
        for (const device of appleDevices) {
            const cleanId = device.serialNumber.replace('FRESH-', '').replace('LEDUO-', '');
            await Clientes.findByIdAndUpdate(cleanId, { hasWallet: true, walletPlatform: 'apple' });
            log.push(`🍏 Apple set: ${cleanId}`);
        }

        // 2. GOOGLE (Con lógica 'both')
        const googleObjects = await GoogleWalletObject.find({});
        for (const obj of googleObjects) {
            const cleanId = obj.clienteId;
            if (cleanId) {
                const cliente = await Clientes.findById(cleanId);
                let platform = 'google';
                if (cliente && cliente.walletPlatform === 'apple') {
                    platform = 'both'; // Si ya tenía Apple, ahora tiene AMBOS
                }
                
                await Clientes.findByIdAndUpdate(cleanId, { hasWallet: true, walletPlatform: platform });
                log.push(`🤖 Google set (${platform}): ${cleanId}`);
            }
        }

        res.json({ message: "Sincronización terminada", log });
    } catch (err) {
        res.status(500).json(err);
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