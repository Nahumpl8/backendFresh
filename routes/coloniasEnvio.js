const router = require('express').Router();
const ColoniaEnvio = require('../models/ColoniaEnvio');

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// GET /api/colonias-envio  -> lista (admin). ?q= busca por colonia/cp/municipio, ?activo=1
router.get('/', async (req, res) => {
    try {
        const filtro = {};
        if (req.query.activo === '1') filtro.activo = true;
        if (req.query.activo === '0') filtro.activo = false;
        if (req.query.q) {
            const q = req.query.q.trim();
            filtro.$or = [
                { colonia: { $regex: q, $options: 'i' } },
                { cp: { $regex: '^' + q } },
                { municipio: { $regex: q, $options: 'i' } },
            ];
        }
        const items = await ColoniaEnvio.find(filtro).sort({ municipio: 1, colonia: 1 }).limit(req.query.q ? 200 : 2000);
        res.status(200).json(items);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/colonias-envio/cp/:cp  -> colonias ACTIVAS de un CP (para la tienda web)
router.get('/cp/:cp', async (req, res) => {
    try {
        const cp = String(req.params.cp || '').replace(/\D/g, '').slice(0, 5);
        if (cp.length !== 5) return res.status(400).json({ error: 'CP inválido' });
        const items = await ColoniaEnvio.find({ cp, activo: true })
            .select('colonia municipio costoEnvio gratisJueves')
            .sort({ colonia: 1 });
        res.status(200).json({ cp, cobertura: items.length > 0, colonias: items });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/colonias-envio  -> crear una colonia
router.post('/', async (req, res) => {
    try {
        const { cp = '', colonia, municipio = '', costoEnvio = 0, gratisJueves = false, activo = true } = req.body || {};
        if (!colonia) return res.status(400).json({ error: 'Falta la colonia' });
        const nueva = await ColoniaEnvio.create({
            cp: String(cp).replace(/\D/g, '').slice(0, 5),
            colonia: colonia.trim(),
            municipio: municipio.trim(),
            costoEnvio: Number(costoEnvio) || 0,
            gratisJueves: !!gratisJueves,
            activo: !!activo,
        });
        res.status(201).json(nueva);
    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ error: 'Esa colonia ya existe en ese CP' });
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/colonias-envio/:id  -> editar costo / gratisJueves / activo / datos
router.put('/:id', async (req, res) => {
    try {
        const set = {};
        ['cp', 'colonia', 'municipio', 'costoEnvio', 'gratisJueves', 'activo'].forEach(k => {
            if (req.body[k] === undefined) return;
            if (k === 'costoEnvio') set[k] = Number(req.body[k]) || 0;
            else if (k === 'gratisJueves' || k === 'activo') set[k] = !!req.body[k];
            else if (k === 'cp') set[k] = String(req.body[k]).replace(/\D/g, '').slice(0, 5);
            else set[k] = String(req.body[k]).trim();
        });
        const upd = await ColoniaEnvio.findByIdAndUpdate(req.params.id, { $set: set }, { new: true });
        if (!upd) return res.status(404).json({ error: 'No encontrada' });
        res.status(200).json(upd);
    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ error: 'Ya existe esa colonia en ese CP' });
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/colonias-envio/:id
router.delete('/:id', async (req, res) => {
    try {
        await ColoniaEnvio.findByIdAndDelete(req.params.id);
        res.status(200).json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Helper reutilizable: costo de envío por (cp, colonia). Devuelve null si no hay cobertura.
async function envioPorColonia(cp, colonia) {
    const cpClean = String(cp || '').replace(/\D/g, '').slice(0, 5);
    if (!colonia) return null;
    const q = { colonia: { $regex: '^' + norm(colonia).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' }, activo: true };
    if (cpClean) q.cp = cpClean;
    const doc = await ColoniaEnvio.findOne(q);
    if (!doc) return null;
    return { costoEnvio: doc.costoEnvio, gratisJueves: doc.gratisJueves };
}

module.exports = router;
module.exports.envioPorColonia = envioPorColonia;
