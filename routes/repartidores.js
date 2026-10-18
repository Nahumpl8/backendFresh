const router = require('express').Router();
const jwt = require('jsonwebtoken');
const Repartidor = require('../models/Repartidor');
const { requireAdmin, leerAdmin, secretoAdmin } = require('../utils/adminMiddleware');
const { olvidarRepartidor } = require('../utils/repartidorAuth');
const { hashPassword, verificarPassword } = require('../utils/password');

// Listar. Público para el selector de la app, pero solo nombres: el teléfono y
// si tiene PIN los ve solo un admin.
router.get('/', async (req, res) => {
    try {
        const admin = await leerAdmin(req);
        const lista = await Repartidor.find().select('+pinHash').sort({ nombre: 1 }).lean();
        res.json(lista.map((r) => (admin
            ? { _id: r._id, nombre: r.nombre, telefono: r.telefono, activo: r.activo, tienePin: Boolean(r.pinHash) }
            : { _id: r._id, nombre: r.nombre, activo: r.activo, tienePin: Boolean(r.pinHash) })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Login con PIN (límite de intentos en memoria) ---
const VENTANA_MS = 15 * 60 * 1000;
const fallos = new Map();
const ipDe = (req) => String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
const contar = (k) => { const f = fallos.get(k); return f && Date.now() - f.desde < VENTANA_MS ? f.n : 0; };
const fallar = (k) => { const f = fallos.get(k); if (!f || Date.now() - f.desde >= VENTANA_MS) fallos.set(k, { n: 1, desde: Date.now() }); else f.n++; };

router.post('/login', async (req, res) => {
    const { id, pin } = req.body || {};
    const kIp = `ip:${ipDe(req)}`;
    const kId = `id:${id}`;
    if (contar(kIp) >= 10 || contar(kId) >= 5) {
        return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
    }
    try {
        const r = /^[a-f0-9]{24}$/i.test(String(id || '')) ? await Repartidor.findById(id).select('+pinHash') : null;
        if (!r || r.activo === false || !r.pinHash || !verificarPassword(String(pin || ''), r.pinHash)) {
            fallar(kIp); fallar(kId);
            if (r && !r.pinHash) return res.status(403).json({ error: 'Aún no tienes PIN. Pídele a un administrador que te lo asigne.' });
            return res.status(401).json({ error: 'PIN incorrecto' });
        }
        fallos.delete(kId);
        const token = jwt.sign({ role: 'repartidor', sub: String(r._id), telefono: r.telefono, nombre: r.nombre, v: r.sesionVersion || 0 },
            secretoAdmin(), { expiresIn: '30d' });
        console.log(`🚚 Login repartidor: ${r.nombre}`);
        res.json({ token, repartidor: { _id: r._id, nombre: r.nombre, telefono: r.telefono } });
    } catch (err) {
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// Crear (admin)
router.post('/', requireAdmin, async (req, res) => {
    try {
        const { nombre, telefono } = req.body;
        if (!nombre || !telefono) {
            return res.status(400).json({ error: 'Nombre y teléfono requeridos' });
        }
        const nuevo = await Repartidor.create({ nombre, telefono });
        res.status(201).json(nuevo);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ error: 'Ya existe un repartidor con ese teléfono' });
        }
        res.status(500).json({ error: err.message });
    }
});

// Editar / activar / desactivar / asignar PIN (admin)
router.patch('/:id', requireAdmin, async (req, res) => {
    try {
        const cambios = {};
        for (const k of ['nombre', 'telefono', 'activo']) if (k in req.body) cambios[k] = req.body[k];
        const inc = {};
        if ('pin' in req.body) {
            if (!/^\d{4}$/.test(String(req.body.pin))) return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos' });
            cambios.pinHash = hashPassword(String(req.body.pin));
            inc.sesionVersion = 1;                     // cierra sus sesiones anteriores
        }
        if (req.body.activo === false) inc.sesionVersion = 1;
        const actualizado = await Repartidor.findByIdAndUpdate(
            req.params.id,
            { $set: cambios, ...(Object.keys(inc).length ? { $inc: inc } : {}) },
            { new: true }
        );
        if (!actualizado) return res.status(404).json({ error: 'No encontrado' });
        olvidarRepartidor(req.params.id);
        if ('pin' in req.body) console.log(`🔑 PIN asignado a repartidor ${actualizado.nombre} por ${req.admin.usuario}`);
        res.json({ _id: actualizado._id, nombre: actualizado.nombre, telefono: actualizado.telefono,
            activo: actualizado.activo, tienePin: Boolean(cambios.pinHash) || undefined });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
