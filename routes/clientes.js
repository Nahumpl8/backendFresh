const router = require('express').Router();
const Clientes = require('../models/Clientes');
const { verifyToken } = require('./verifyToken');
const Pedido = require('../models/Pedidos');
const WalletDevice = require('../models/WalletDevice');
const { sendWelcomeEmail } = require('../utils/emailService');

// Utilidad para limpiar teléfono
function limpiarTelefono(tel) {
    return tel.replace(/\D/g, '').replace(/^52/, '').trim();
}

// Utilidad para normalizar texto
function normalizarTexto(texto) {
    return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// 1. HELPER PARA GENERAR CÓDIGOS DE SEMANA (Pon esto antes de las rutas)
function getWeekStrings(weeksBack) {
    const current = new Date();
    // Ajuste para obtener el número de semana ISO
    const target = new Date(current.valueOf());
    const dayNr = (current.getDay() + 6) % 7;
    target.setDate(target.getDate() - dayNr + 3);
    const firstThursday = target.valueOf();
    target.setMonth(0, 1);
    if (target.getDay() !== 4) {
        target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
    }
    const currentWeekNumber = 1 + Math.ceil((firstThursday - target) / 604800000);
    const currentYear = current.getFullYear();

    let weeks = [];

    // Generamos las semanas hacia atrás
    for (let i = 0; i <= weeksBack; i++) {
        let w = currentWeekNumber - i;
        let y = currentYear;

        // Manejo del cambio de año (si retrocedemos de la semana 1 a la 52)
        while (w <= 0) {
            y--;
            w += 52; // Aproximación estándar, suficiente para Fresh Market
        }

        weeks.push(`${y}-${w}`); // Formato "2026-2"
    }
    return weeks;
}

async function verificarRegaloDigital(cliente) {
    try {
        // 1. Requisitos
        const tieneWallet = cliente.hasWallet || (cliente.walletPlatform && cliente.walletPlatform !== 'none');
        const tieneEmail = cliente.email && cliente.email.includes('@');

        if (tieneEmail && tieneWallet) {

            // 2. Verificar duplicados (Tenemos que parsear para leer porque ahora guardaremos strings)
            const yaTienePremio = cliente.premiosPendientes && cliente.premiosPendientes.some(p => {
                // Si es string lo parseamos, si es objeto lo leemos directo
                const premio = typeof p === 'string' ? JSON.parse(p) : p;
                return premio.type === 'regalo_wallet';
            });

            if (!yaTienePremio) {
                console.log(`🎁 ¡Premio Digital desbloqueado para: ${cliente.nombre}!`);

                // 3. Inyectar el premio COMO TEXTO (JSON STRING)
                // 👇👇👇 AQUÍ ESTÁ EL CAMBIO CLAVE 👇👇👇
                const nuevoPremio = {
                    label: '250g Jamón/Queso (Regalo Digital)',
                    type: 'regalo_wallet',
                    value: 0,
                    expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 días
                    redeemed: false
                };

                // Usamos JSON.stringify porque tu Schema define esto como [String]
                cliente.premiosPendientes.push(JSON.stringify(nuevoPremio));

                await cliente.save();
                return true;
            }
        }
        return false;
    } catch (error) {
        console.error("Error verificando regalo:", error);
        return false;
    }
}

router.get('/audience', async (req, res) => {
    try {
        console.log("🔍 Buscando audiencia..."); // Log para debug en Railway
        const audience = await Clientes.find({
            $or: [
                { hasWallet: true },
                { walletPlatform: { $in: ['apple', 'google', 'both'] } }
            ]
        })
            .select('nombre telefono hasWallet walletPlatform sellos puntos updatedAt')
            .sort({ updatedAt: -1 });

        console.log(`📢 Audiencia encontrada: ${audience.length} clientes`);
        res.json(audience);
    } catch (err) {
        console.error("Error obteniendo audiencia:", err);
        res.status(500).json({ error: 'Error obteniendo audiencia' });
    }
});

// Crear nuevo cliente
router.post('/new', async (req, res) => {
    // Normalizamos email si viene
    if (req.body.email) req.body.email = req.body.email.toLowerCase().trim();

    const newClientes = new Clientes(req.body);
    try {
        const savedClientes = await newClientes.save();

        // 👇 AGREGAR ESTO: Enviar correo si se registró con email
        if (savedClientes.email) {
            console.log("📧 Enviando bienvenida a usuario nuevo...");
            sendWelcomeEmail(savedClientes.email, savedClientes.nombre, savedClientes._id.toString())
                .catch(err => console.error('Error welcome email (new):', err));
        }
        // 👆 FIN DE LO AGREGADO

        res.status(201).json(savedClientes);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// Guardar email de un cliente tras el pedido (captura "recibe ofertas por email").
// Sin PIN. Solo setea el email si el cliente NO tiene uno (no sobrescribe).
router.post('/guardar-email', async (req, res) => {
    try {
        const { telefono, email } = req.body;
        if (!telefono || !email) {
            return res.status(400).json({ ok: false, error: 'Faltan datos' });
        }
        const emailLimpio = String(email).toLowerCase().trim();

        // Match por sufijo de teléfono (igual que el resto de rutas)
        const cliente = await Clientes.findOne({ telefono: { $regex: telefono + '$' } });
        if (!cliente) {
            return res.status(404).json({ ok: false, error: 'Cliente no encontrado' });
        }

        // No sobrescribir un email existente
        if (cliente.email) {
            return res.status(200).json({ ok: true, yaExistia: true });
        }

        // Evitar chocar con el índice único sparse (email ya usado por otro cliente)
        const enUso = await Clientes.findOne({ email: emailLimpio });
        if (enUso) {
            return res.status(409).json({ ok: false, error: 'Ese correo ya está registrado en otra cuenta' });
        }

        cliente.email = emailLimpio;
        await cliente.save();

        // Bienvenida (fire-and-forget) para clientes que dejan su email por primera vez
        sendWelcomeEmail(cliente.email, cliente.nombre, cliente._id.toString())
            .catch(err => console.error('Error welcome email (guardar-email):', err));

        res.status(200).json({ ok: true });
    } catch (err) {
        console.error("❌ Error en /guardar-email:", err);
        res.status(500).json({ ok: false });
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
        const clienteAnterior = await Clientes.findById(req.params.id);
        if (!clienteAnterior) {
            return res.status(404).json({ error: 'Cliente no encontrado' });
        }

        const emailAnterior = clienteAnterior.email;
        const nuevoEmail = req.body.email ? req.body.email.toLowerCase().trim() : null;

        // 👇 CAMBIO IMPORTANTE: Usar 'let' en lugar de 'const'
        let updatedClientes = await Clientes.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });

        // Enviar correo de bienvenida (Solo si es un correo NUEVO)
        if (req.body.email && updatedClientes.email) {
            console.log("📧 Disparando bienvenida (Admin guardó email)...");
            sendWelcomeEmail(updatedClientes.email, updatedClientes.nombre, updatedClientes._id.toString())
                .catch(err => console.error('Error enviando correo de bienvenida:', err));
        }

        // 👇 AGREGAR: Si quieres forzar el envío aunque ya tenga correo (solo para pruebas o correcciones)
        // Puedes agregar un flag en el body, por ejemplo: req.body.forceEmail
        if (req.body.forceEmail && updatedClientes.email) {
            sendWelcomeEmail(updatedClientes.email, updatedClientes.nombre, updatedClientes._id.toString())
                .catch(err => console.error('Error enviando correo forzado:', err));
        }

        // Verificar Regalo Digital
        await verificarRegaloDigital(updatedClientes);

        // Recargar datos para devolver el premio actualizado
        updatedClientes = await Clientes.findById(req.params.id);

        res.status(200).json(updatedClientes);
    } catch (err) {
        console.error(err); // Ahora verás el error en la consola si falla algo más
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
// 🚀 OBTENER CLIENTES (FILTROS + WALLET + SIN PEDIDO RECIENTE)
// ====================================================================
router.get('/', async (req, res) => {
    try {
        // 1. EXTRAER PARÁMETROS
        // Agregamos 'notOrderedWeek'
        const { page = 1, limit = 10, q, time, spending, notOrderedWeek } = req.query;
        const WalletDevice = require('../models/WalletDevice');
        // Asegúrate de que Pedido esté importado arriba: const Pedido = require('../models/Pedidos');

        // 2. CONSTRUIR QUERY INICIAL
        let queryObj = {};

        // --- A. Filtro de Búsqueda (Texto) ---
        if (q && q.length > 0) {
            const regex = new RegExp(q, 'i');
            queryObj.$or = [{ nombre: regex }, { telefono: regex }];
        }

        if (time && time !== 'all') {
            let weeksToInclude = [];

            // Definimos cuántas semanas atrás queremos ver
            switch (time) {
                case '1week': // Esta semana
                    weeksToInclude = getWeekStrings(0);
                    break;
                case '1month': // Últimas 4 semanas
                    weeksToInclude = getWeekStrings(4);
                    break;
                case '3months': // Últimas 12 semanas
                    weeksToInclude = getWeekStrings(12);
                    break;
                case '6months': // Últimas 24 semanas
                    weeksToInclude = getWeekStrings(24);
                    break;
            }

            // Usamos $in para buscar coincidencias exactas en el array de semanas
            if (weeksToInclude.length > 0) {
                queryObj.ultimaSemanaRegistrada = { $in: weeksToInclude };
            }
        }

        // --- C. Filtro de Gasto ---
        if (spending && spending !== 'all') {
            switch (spending) {
                case 'low': queryObj.totalGastado = { $lt: 500 }; break;
                case 'mid': queryObj.totalGastado = { $gte: 500, $lte: 1500 }; break;
                case 'high': queryObj.totalGastado = { $gt: 1500 }; break;
            }
        }

        // --- D. 🔥 NUEVO FILTRO: NO HAN PEDIDO ESTA SEMANA ---
        if (notOrderedWeek === 'true') {
            // Buscamos pedidos creados en los últimos 7 días
            const sieteDiasAtras = new Date(new Date().setDate(new Date().getDate() - 7));

            const pedidosRecientes = await Pedido.find({
                createdAt: { $gte: sieteDiasAtras }
            }).select('telefono');

            const telefonosActivos = pedidosRecientes.map(p => p.telefono);

            // EXCLUIR esos teléfonos ($nin = Not In)
            // Si ya había un filtro de teléfono (por búsqueda), usamos $and para no sobrescribirlo
            if (queryObj.$or) {
                queryObj.$and = [
                    { $or: queryObj.$or },
                    { telefono: { $nin: telefonosActivos } }
                ];
                delete queryObj.$or; // Movemos el $or adentro del $and
            } else {
                queryObj.telefono = { $nin: telefonosActivos };
            }
        }

        // 3. EJECUTAR CONSULTA (Count + Find)
        const totalItems = await Clientes.countDocuments(queryObj);

        const campos = 'nombre direccion telefono telefonoSecundario gpsLink puntos sellos hasWallet walletPlatform misDirecciones ultimaSemanaRegistrada premiosPendientes createdAt updatedAt totalGastado totalPedidos email';

        const clientes = await Clientes.find(queryObj)
            .select(campos)
            .sort({ updatedAt: -1 }) // Ordenar por actividad reciente
            .skip((parseInt(page) - 1) * parseInt(limit))
            .limit(parseInt(limit))
            .lean();

        // -------------------------------------------------------------
        // 4. LÓGICA DE REPARACIÓN DE WALLETS (TU CÓDIGO ORIGINAL) 🎩
        // -------------------------------------------------------------
        const walletDevices = await WalletDevice.find({}, 'serialNumber').lean();

        const idsConApple = new Set(walletDevices.map(d =>
            d.serialNumber.replace('FRESH-', '').replace('LEDUO-', '')
        ));

        const clientesCorregidos = clientes.map(cliente => {
            const idString = cliente._id.toString();
            const tieneAppleReal = idsConApple.has(idString);

            if (tieneAppleReal) {
                if (!cliente.hasWallet) return { ...cliente, hasWallet: true, walletPlatform: 'apple' };
                if (cliente.walletPlatform === 'google') return { ...cliente, hasWallet: true, walletPlatform: 'both' };
                if (!cliente.walletPlatform) return { ...cliente, hasWallet: true, walletPlatform: 'apple' };
            }
            return cliente;
        });
        // -------------------------------------------------------------

        // 5. RESPONDER
        res.status(200).json({
            data: clientesCorregidos,
            totalPages: Math.ceil(totalItems / parseInt(limit)),
            currentPage: parseInt(page),
            totalItems: totalItems
        });

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

        // 3. BARRIDO DE PREMIOS (Dar regalo a quienes ya completaron todo)
        const candidatos = await Clientes.find({
            hasWallet: true,
            email: { $ne: null }
        });

        let premiosNuevos = 0;
        for (const c of candidatos) {
            const gano = await verificarRegaloDigital(c);
            if (gano) premiosNuevos++;
        }
        log.push(`🎁 Premios inyectados en esta sincro: ${premiosNuevos}`);

        res.json({ message: "Sincronización terminada", log });
    } catch (err) {
        res.status(500).json(err);
    }


});


// GET /api/clientes/debug-google
router.get('/debug-google', async (req, res) => {
    try {
        const GoogleWalletObject = require('../models/GoogleWalletObject');

        // 1. Traer TODOS los objetos de Google para ver su estructura
        const all = await GoogleWalletObject.find({});

        // 2. Buscar específicamente al de Don James
        const targetId = '69519ba81db92467a91a265d';
        const specific = await GoogleWalletObject.findOne({ clienteId: targetId });

        res.json({
            totalObjects: all.length,
            structureExample: all[0], // Para ver si el campo se llama 'clienteId', 'clientId', 'user_id', etc.
            foundSpecific: specific ? "SÍ ENCONTRADO" : "NO ENCONTRADO",
            targetIdBuscado: targetId,
            allIds: all.map(o => o.clienteId) // Lista de todos los IDs guardados
        });
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
            .select('nombre direccion telefono telefonoSecundario gpsLink puntos sellos hasWallet walletPlatform misDirecciones ultimaSemanaRegistrada premiosPendientes email')
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
            'miércoles, 21 Enero 2026',
            'jueves, 22 Enero 2026',
            'viernes, 23 Enero 2026',
            'sábado, 24 Enero 2026',
            'domingo, 25 Enero 2026',
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
        const allClientes = await Clientes.find().select('_id nombre telefono email');

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
                        email: cliente.email,
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