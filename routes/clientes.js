const router = require('express').Router();
const Clientes = require('../models/Clientes');
const { verifyToken } = require('./verifyToken');
const Pedido = require('../models/Pedidos');
const WalletDevice = require('../models/WalletDevice'); // <--- IMPORTAR ESTO ARRIBA


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

        // Buscar cliente por teléfono
        const cliente = await Clientes.findOne({
            telefono: { $regex: telefono + '$' }
        });

        if (!cliente) {
            return res.status(404).json({ mensaje: 'Cliente no encontrado.' });
        }

        // Buscar pedidos del cliente
        const pedidos = await Pedido.find({
            telefono: { $regex: telefono + '$' }
        }).sort({ fecha: -1 }); // opcional: ordenados por fecha descendente

        res.json({
            cliente,
            pedidos
        });
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

// Buscar cliente por nombre y teléfono (normalizado)
router.post('/buscar', async (req, res) => {
    let { telefono } = req.body;
    if (!telefono) {
        return res.status(400).json({ error: 'Teléfono es requerido.' });
    }

    const telefonoNormalizado = limpiarTelefono(telefono);

    try {
        const cliente = await Clientes.findOne({
            telefono: { $regex: telefonoNormalizado + '$' } // termina en el número limpio
        });

        if (!cliente) {
            return res.status(404).json({ mensaje: 'Cliente no encontrado.' });
        }

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

// Obtener todos los clientes
// GET ALL CLIENTS
router.get('/', async (req, res) => {
    try {
        // 1. Buscamos todos los clientes como siempre
        const clientes = await Clientes.find().sort({ nombre: 1 });

        // 2. [NUEVO] Verificamos quién tiene Wallet instalada
        // Usamos Promise.all para esperar a que se revisen todos
        const clientesConWallet = await Promise.all(clientes.map(async (c) => {

            // El ID del pase es "FRESH-" + el ID del cliente
            const serialNumber = `FRESH-${c._id}`;

            // Contamos si hay dispositivos registrados con ese serial
            const deviceCount = await WalletDevice.countDocuments({ serialNumber: serialNumber });

            // Devolvemos el cliente convertido a objeto simple + la bandera hasWallet
            return {
                ...c.toObject(), // Importante: convertir a objeto JS normal para poder editarlo
                hasWallet: deviceCount > 0 // true si encontró algo, false si es 0
            };
        }));

        // 3. Respondemos con la lista enriquecida
        res.status(200).json(clientesConWallet);

    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// --- RUTA NUEVA: AGREGAR DIRECCIÓN EXTRA ---
router.put('/add-address/:id', async (req, res) => {
    try {
        const { alias, direccion, gpsLink } = req.body;

        // Validamos que venga al menos la dirección
        if (!direccion) return res.status(400).json("Falta la dirección");

        const clienteActualizado = await Clientes.findByIdAndUpdate(
            req.params.id,
            {
                $push: {
                    misDirecciones: {
                        alias: alias || 'Nueva Dirección', // Si no mandas alias, pone uno default
                        direccion: direccion,
                        gpsLink: gpsLink || ''
                    }
                }
            },
            { new: true } // Devuelve el cliente ya actualizado para ver el cambio
        );

        res.status(200).json(clienteActualizado);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});


// --- RUTA ULTRA LIGERA PARA REPARTIDORES ---
// Devuelve solo lo necesario para entregar. Ahorra 90% de ancho de banda.
router.get('/lite', async (req, res) => {
    try {
        const clientes = await Clientes.find()
            .select('_id nombre telefono telefonoSecundario direccion misDirecciones gpsLink');
        // .select() elige qué campos TRAER, ignorando pedidos, puntos, etc.

        res.status(200).json(clientes);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// rutas/clientes.js o donde tengas tus rutas
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

        // Obtener todos los pedidos con fecha de esta semana
        const pedidosSemana = await Pedido.find({ fecha: { $in: fechasSemana } });

        // Extraer teléfonos de los clientes que ya hicieron pedido
        const telefonosActivos = pedidosSemana.map(p => p.telefono);

        // Obtener todos los clientes que NO están en la lista de pedidos
        const clientesInactivos = await Clientes.find({
            telefono: { $nin: telefonosActivos }
        });

        res.json(clientesInactivos);
    } catch (error) {
        console.error('Error al obtener clientes inactivos:', error);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// Estadísticas
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
        console.error(err);
        res.status(500).json(err);
    }
});

module.exports = router;
