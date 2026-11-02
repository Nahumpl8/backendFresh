const router = require('express').Router();
const Encuesta = require('../models/Encuesta');
const Config = require('../models/Config');
const { requireAdmin } = require('../utils/adminMiddleware');
const enc = require('../utils/encuestas');

const soloAdmin = requireAdmin;
const isoValido = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// ---------------------------------------------------------------------------
// Página pública (freshmarket.mx/encuesta/:token): el token identifica al cliente
// ---------------------------------------------------------------------------
router.get('/r/:token', async (req, res) => {
    try {
        const e = await enc.paraContestar(req.params.token);
        if (!e) return res.status(404).json({ error: 'Esta encuesta no existe o el enlace está incompleto.' });
        res.json(e);
    } catch (err) {
        console.error('❌ Encuesta GET:', err.message);
        res.status(500).json({ error: 'No se pudo abrir la encuesta' });
    }
});

router.post('/r/:token', async (req, res) => {
    try {
        res.json(await enc.contestar(req.params.token, req.body || {}));
    } catch (err) {
        if (!err.status) console.error('❌ Encuesta POST:', err.message);
        res.status(err.status || 400).json({ error: err.message || 'No se pudo guardar' });
    }
});

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
router.get('/admin/config', soloAdmin, async (req, res) => {
    res.json({
        regalo: await enc.regaloActual(),
        auto: (await enc.leerConfig('encuestaAuto', 'si')) === 'si',
        preguntas: enc.PREGUNTAS,
        version: enc.VERSION,
    });
});

router.put('/admin/config', soloAdmin, async (req, res) => {
    const { regalo, auto } = req.body || {};
    const set = (key, value) => Config.updateOne({ key }, { $set: { value: String(value).slice(0, 120), updatedAt: new Date() } }, { upsert: true });
    if (regalo != null) {
        if (!String(regalo).trim()) return res.status(400).json({ error: 'Escribe el regalo' });
        await set('encuestaRegalo', String(regalo).trim());
    }
    if (auto != null) await set('encuestaAuto', auto ? 'si' : 'no');
    res.json({ ok: true });
});

/** Cuántos recibirían encuesta por las entregas de [desde, hasta] (no manda nada). */
router.get('/admin/vista-previa', soloAdmin, async (req, res) => {
    const { desde, hasta } = req.query;
    if (!isoValido(desde) || !isoValido(hasta) || desde > hasta) return res.status(400).json({ error: 'Fechas inválidas' });
    try {
        const { conteo } = await enc.candidatos(desde, hasta);
        res.json(conteo);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Manda ya las encuestas de las entregas de [desde, hasta]. Sigue en segundo plano. */
router.post('/admin/enviar', soloAdmin, async (req, res) => {
    const { desde, hasta } = req.body || {};
    if (!isoValido(desde) || !isoValido(hasta) || desde > hasta) return res.status(400).json({ error: 'Fechas inválidas' });
    if (desde < enc.sumarDias(enc.hoyMX(), -14)) return res.status(400).json({ error: 'Solo entregas de las últimas 2 semanas' });
    const actual = enc.estadoEnvio();
    if (actual && !actual.terminado) return res.status(409).json({ error: 'Ya hay un envío en marcha', estado: actual });
    enc.enviarRango(desde, hasta, 'campana').catch((err) => console.error('❌ Envío de encuestas:', err.message));
    console.log(`📋 Envío de encuestas ${desde}..${hasta} pedido por ${req.admin?.usuario || 'admin'}`);
    res.json({ ok: true });
});

router.get('/admin/estado-envio', soloAdmin, (req, res) => res.json(enc.estadoEnvio() || null));

router.get('/admin/resumen', soloAdmin, async (req, res) => {
    try {
        res.json(await enc.resumen(isoValido(req.query.desde) ? req.query.desde : null));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Respuestas: ?filtro=malas|pendientes|todas */
router.get('/admin/respuestas', soloAdmin, async (req, res) => {
    const filtro = { respondidaAt: { $ne: null } };
    if (req.query.filtro === 'malas') filtro.mala = true;
    if (req.query.filtro === 'pendientes') filtro['seguimiento.estado'] = 'pendiente';
    const lista = await Encuesta.find(filtro, { token: 0 }).sort({ respondidaAt: -1 }).limit(Math.min(Number(req.query.limit) || 200, 500)).lean();
    res.json(lista);
});

router.put('/admin/:id/seguimiento', soloAdmin, async (req, res) => {
    const { estado, nota } = req.body || {};
    if (!['pendiente', 'atendida'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    const r = await Encuesta.updateOne({ _id: req.params.id }, {
        $set: { seguimiento: { estado, nota: String(nota || '').slice(0, 500), por: req.admin?.nombre || req.admin?.usuario || 'admin', at: new Date() } },
    }).catch(() => null);
    if (!r || !r.matchedCount) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true });
});

/** ¿Este cliente tiene regalo de encuesta esperando? (aviso al capturar el pedido) */
router.get('/admin/regalo/:telefono', soloAdmin, async (req, res) => {
    res.json(await enc.regaloPendiente(req.params.telefono));
});

module.exports = router;
