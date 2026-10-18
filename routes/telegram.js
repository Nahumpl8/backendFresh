/**
 * Rutas de Telegram. Solo se montan si TELEGRAM_ENABLED=true (ver index.js).
 *
 * Dos tipos de endpoint:
 *   - el webhook, que llama Telegram y se autentica con un secreto compartido
 *   - los de administración, todos con requireAdmin
 *
 * Ninguno queda abierto.
 */

const router = require('express').Router();
const crypto = require('crypto');
const { requireAdmin } = require('../utils/adminMiddleware');
const TelegramChat = require('../models/TelegramChat');
const Clientes = require('../models/Clientes');
const Config = require('../models/Config');
const tg = require('../utils/telegram');
const bot = require('../utils/telegramBot');

// Revisa cada 5 min si abrieron los pedidos para avisar a quien escribió en fin de semana.
bot.iniciarAvisosApertura();

const SECRETO = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const RUTA_SECRETA = process.env.TELEGRAM_WEBHOOK_PATH || '';

/**
 * Comparación en tiempo constante de dos cadenas.
 * `timingSafeEqual` exige la misma longitud, así que se comparan los hashes:
 * así tampoco se filtra la longitud del secreto.
 */
function igualSeguro(a, b) {
    const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
    const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// WEBHOOK
// ---------------------------------------------------------------------------

/**
 * Telegram no firma el cuerpo (a diferencia de Stripe): devuelve en cada
 * petición el `secret_token` que registramos, en una cabecera. Eso es una
 * ventaja aquí, porque no hace falta el cuerpo crudo y el express.json global
 * no estorba.
 *
 * Tres capas: segmento secreto en la ruta, cabecera comparada en tiempo
 * constante, y el límite de 64 kb que pone index.js.
 */
router.post('/webhook/:secretPath', async (req, res) => {
    if (!SECRETO || !RUTA_SECRETA) return res.sendStatus(404);
    if (!igualSeguro(req.params.secretPath, RUTA_SECRETA)) return res.sendStatus(404);
    if (!igualSeguro(req.get('X-Telegram-Bot-Api-Secret-Token'), SECRETO)) return res.sendStatus(401);

    // Responder 200 YA y procesar después. Telegram reintenta ante cualquier
    // respuesta que no sea 2xx y encola los updates de ese chat detrás del
    // lento, así que la regla es: confirmar primero, trabajar después.
    res.sendStatus(200);

    bot.procesarUpdate(req.body).catch((e) => console.error('❌ webhook:', e.message));
});

// ---------------------------------------------------------------------------
// ADMINISTRACIÓN (todo con requireAdmin)
// ---------------------------------------------------------------------------

/** Estado del bot y del webhook. El mejor diagnóstico disponible. */
router.get('/estado', requireAdmin, async (req, res) => {
    try {
        const [me, info, modoCfg] = await Promise.all([
            tg.getMe(),
            tg.getWebhookInfo(),
            Config.findOne({ key: 'telegram_modo' }).lean(),
        ]);

        const [total, vinculados, enEspera, bloqueados, sinFicha, beta] = await Promise.all([
            TelegramChat.countDocuments(),
            TelegramChat.countDocuments({ clienteId: { $ne: null } }),
            TelegramChat.countDocuments({ enEspera: true }),
            TelegramChat.countDocuments({ bloqueado: true }),
            TelegramChat.countDocuments({ clienteId: null, telefono: { $ne: null } }),
            Clientes.countDocuments({ telegramBeta: true }),
        ]);

        res.json({
            bot: me.ok ? { username: me.resultado.username, nombre: me.resultado.first_name } : null,
            tokenValido: me.ok,
            webhook: info.ok ? {
                url: info.resultado.url || null,
                pendientes: info.resultado.pending_update_count,
                ultimoError: info.resultado.last_error_message || null,
                ultimoErrorAt: info.resultado.last_error_date
                    ? new Date(info.resultado.last_error_date * 1000).toISOString() : null,
            } : null,
            modo: modoCfg && modoCfg.value === 'publico' ? 'publico' : 'beta',
            suscriptores: { total, vinculados, enEspera, bloqueados, sinFicha },
            enListaBeta: beta,
        });
    } catch (err) {
        console.error('❌ /telegram/estado:', err);
        res.status(500).json({ error: err.message });
    }
});

/** Lista de suscriptores. */
router.get('/suscriptores', requireAdmin, async (req, res) => {
    try {
        const filtro = {};
        if (req.query.enEspera === 'true') filtro.enEspera = true;
        if (req.query.sinFicha === 'true') { filtro.clienteId = null; }

        const chats = await TelegramChat.find(filtro)
            .populate('clienteId', 'nombre telefono sellos puntos premioDisponible')
            .sort({ createdAt: -1 })
            .limit(Math.min(parseInt(req.query.limit, 10) || 200, 1000))
            .lean();

        res.json(chats.map((c) => ({
            chatId: c.chatId,
            nombre: c.clienteId ? c.clienteId.nombre : [c.firstName, c.lastName].filter(Boolean).join(' '),
            username: c.username,
            telefono: c.telefono || (c.clienteId ? c.clienteId.telefono : null),
            vinculado: Boolean(c.clienteId),
            enEspera: c.enEspera,
            bloqueado: c.bloqueado,
            optIn: c.optIn,
            origen: c.origen,
            metodo: c.metodoVinculacion,
            desde: c.createdAt,
            sellos: c.clienteId ? c.clienteId.sellos : null,
        })));
    } catch (err) {
        console.error('❌ /telegram/suscriptores:', err);
        res.status(500).json({ error: err.message });
    }
});

/** Cambia el modo beta/publico sin redeploy. */
router.put('/modo', requireAdmin, async (req, res) => {
    try {
        const { modo } = req.body;
        if (!['beta', 'publico'].includes(modo)) {
            return res.status(400).json({ error: "modo debe ser 'beta' o 'publico'" });
        }
        await Config.findOneAndUpdate(
            { key: 'telegram_modo' },
            { value: modo, updatedAt: new Date() },
            { upsert: true },
        );
        console.log(`🤖 Modo de Telegram -> ${modo}`);
        res.json({ success: true, modo });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Añade o quita clientes de la lista beta, por teléfono. */
router.post('/beta', requireAdmin, async (req, res) => {
    try {
        const { telefono, incluir = true } = req.body;
        const cliente = await bot.buscarClientePorTelefono(telefono);
        if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

        await Clientes.updateOne({ _id: cliente._id }, { $set: { telegramBeta: Boolean(incluir) } });
        res.json({ success: true, cliente: cliente.nombre, enBeta: Boolean(incluir) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/beta', requireAdmin, async (req, res) => {
    try {
        const lista = await Clientes.find({ telegramBeta: true })
            .select('nombre telefono telegramId telegramVinculadoAt')
            .lean();
        res.json(lista.map((c) => ({
            nombre: c.nombre,
            telefono: c.telefono,
            conectado: Boolean(c.telegramId),
            desde: c.telegramVinculadoAt,
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Descarga del PDF de lista de precios, para mandarlo por WhatsApp o
 * imprimirlo. Sustituye al que se arma a mano en Canva cada semana.
 */
router.get('/lista.pdf', requireAdmin, async (req, res) => {
    try {
        const pdf = await require('../utils/listaPdf').generarDesdeBase();
        const fecha = new Date(pdf.generadoAt).toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Lista Fresh Market ${fecha}.pdf"`);
        res.send(pdf.buffer);
    } catch (err) {
        console.error('❌ /telegram/lista.pdf:', err);
        res.status(500).json({ error: 'No se pudo generar la lista' });
    }
});

/** Mensaje de prueba a un chat concreto. */
router.post('/prueba', requireAdmin, async (req, res) => {
    try {
        const { chatId, texto } = req.body;
        if (!chatId || !texto) return res.status(400).json({ error: 'chatId y texto son obligatorios' });
        const r = await bot.responder(chatId, texto);
        res.json(r.ok ? { success: true } : { success: false, tipo: r.tipo, detalle: r.desc });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
