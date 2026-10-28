/**
 * Rutas de reactivación (admin): clientes dormidos o en peligro agrupados por
 * colonia, para visitarlos con la camioneta, y registro de cada visita.
 *
 * La colonia sale del texto de la dirección del último pedido (lo que va antes
 * de la primera coma), porque la mayoría de las fichas no tienen colonia
 * capturada. Los pueblos (Tizayuca, Zapotlán, Metztitlán, Acayuca, Tolcayuca)
 * quedan fuera: ahí se entrega en punto fijo.
 */
const router = require('express').Router();
const Pedido = require('../models/Pedidos');
const Clientes = require('../models/Clientes');
const Visita = require('../models/Visita');
const { requireAdmin } = require('../utils/adminMiddleware');
const { normalizarTelefono } = require('../utils/metricas');

router.use(requireAdmin);

const PUEBLOS = /tizayuca|zapotlan|metztitl|acayuca|tolcayuca/;
const NO_ES_RUTA = /^(pasa a local|recoge|recoger|local)\b/;
const RESULTADOS = ['no_estaba', 'compro', 'pidio', 'no_interesa', 'otro'];
const DIAS_RETORNO = 28;   // "volvió" = compró dentro de 4 semanas después de la visita

const sinAcento = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const claveColonia = (dir) => sinAcento(String(dir || '').split(',')[0])
    .replace(/^(col\.?|colonia|fracc?\.?|fraccionamiento|ampl\.?|ampliacion|priv\.?)\s+/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Misma regla que la página "Clientes en peligro" (routes/clientes.js). */
function segmento(dias, ratio) {
    if (dias > 90) return 'perdido';
    if (dias > 45) return 'dormido';
    if (ratio != null) {
        if (ratio >= 3) return 'dormido';
        if (ratio >= 1.5) return 'en_riesgo';
        return 'activo';
    }
    return dias > 21 ? 'en_riesgo' : 'activo';
}

// La agregación recorre todos los pedidos: se guarda 10 minutos.
let cache = { at: 0, clientes: null };
async function clientesNoActivos() {
    if (cache.clientes && Date.now() - cache.at < 10 * 60000) return cache.clientes;
    const filas = await Pedido.aggregate([
        { $match: { despensa: { $not: /reposici/i } } },
        { $sort: { createdAt: 1 } },
        { $group: {
            _id: '$telefono',
            ult: { $max: '$createdAt' }, pri: { $min: '$createdAt' },
            n: { $sum: 1 }, gasto: { $sum: '$total' },
            dir: { $last: '$direccion' }, nombre: { $last: '$cliente' },
            despensas: { $push: '$despensa' },
        } },
    ]).allowDiskUse(true);
    // Nombre de la ficha (más confiable que el del pedido), por teléfono.
    const fichas = await Clientes.find({}, { telefono: 1, nombre: 1 }).lean();
    const nombreFicha = new Map(fichas.map((f) => [normalizarTelefono(f.telefono), f.nombre]));

    const porTel = new Map();
    for (const f of filas) {
        const t = normalizarTelefono(f._id);
        if (!t) continue;
        const a = porTel.get(t);
        if (!a) { porTel.set(t, { ...f, tel: t }); continue; }
        a.n += f.n; a.gasto += f.gasto; a.despensas.push(...f.despensas);
        if (f.ult > a.ult) { a.ult = f.ult; a.dir = f.dir; a.nombre = f.nombre; }
        if (f.pri < a.pri) a.pri = f.pri;
    }

    const ahora = Date.now();
    const lista = [];
    for (const c of porTel.values()) {
        const dias = Math.floor((ahora - c.ult) / 864e5);
        if (dias > 365 || PUEBLOS.test(sinAcento(c.dir))) continue;
        const gap = c.n > 1 ? (c.ult - c.pri) / 864e5 / (c.n - 1) : null;
        const seg = segmento(dias, gap ? dias / gap : null);
        if (seg === 'activo') continue;
        const colonia = claveColonia(c.dir);
        if (!colonia || NO_ES_RUTA.test(colonia)) continue;
        const cuenta = {};
        for (const d of c.despensas) if (d && !/^pedido$/i.test(d)) cuenta[d] = (cuenta[d] || 0) + 1;
        const favorita = Object.entries(cuenta).sort((a, b) => b[1] - a[1])[0];
        lista.push({
            telefono: c.tel, nombre: nombreFicha.get(c.tel) || c.nombre || '', direccion: c.dir || '', colonia,
            ultimoPedido: c.ult, dias, segmento: seg,
            pedidos: c.n, gastado: Math.round(c.gasto), ticket: Math.round(c.gasto / c.n),
            favorita: favorita ? favorita[0] : 'Pedidos personalizados',
        });
    }
    cache = { at: Date.now(), clientes: lista };
    return lista;
}

// Colonias con clientes por recuperar, primero las que tienen más clientes fieles (3+ pedidos).
router.get('/colonias', async (req, res) => {
    try {
        const col = {};
        for (const c of await clientesNoActivos()) {
            const k = (col[c.colonia] = col[c.colonia] || { colonia: c.colonia, total: 0, fieles: 0, en_riesgo: 0, dormido: 0, perdido: 0 });
            k.total++; k[c.segmento]++; if (c.pedidos >= 3) k.fieles++;
        }
        const visitas = await Visita.aggregate([{ $group: { _id: '$colonia', n: { $sum: 1 } } }]);
        const visitadas = Object.fromEntries(visitas.map((v) => [v._id, v.n]));
        res.json(Object.values(col)
            .filter((c) => c.total >= 5)
            .map((c) => ({ ...c, visitas: visitadas[c.colonia] || 0 }))
            .sort((a, b) => b.fieles - a.fieles || b.total - a.total));
    } catch (err) {
        console.error('❌ reactivacion/colonias:', err.message);
        res.status(500).json({ error: 'No se pudieron calcular las colonias' });
    }
});

// La ruta de una colonia: sus clientes por recuperar, con su última visita.
router.get('/ruta', async (req, res) => {
    try {
        const colonia = String(req.query.colonia || '');
        const clientes = (await clientesNoActivos()).filter((c) => c.colonia === colonia);
        const tels = clientes.map((c) => c.telefono);
        const visitas = await Visita.find({ telefono: { $in: tels } }).sort({ createdAt: -1 }).lean();
        const ultimaVisita = new Map();
        for (const v of visitas) if (!ultimaVisita.has(v.telefono)) ultimaVisita.set(v.telefono, v);
        res.json(clientes.map((c) => ({ ...c, visita: ultimaVisita.get(c.telefono) || null })));
    } catch (err) {
        console.error('❌ reactivacion/ruta:', err.message);
        res.status(500).json({ error: 'No se pudo armar la ruta' });
    }
});

router.post('/visitas', async (req, res) => {
    try {
        const { telefono, nombre, colonia, resultado, monto, nota } = req.body || {};
        const tel = normalizarTelefono(telefono);
        if (!tel) return res.status(400).json({ error: 'Teléfono inválido' });
        if (!RESULTADOS.includes(resultado)) return res.status(400).json({ error: 'Resultado inválido' });
        const v = await Visita.create({
            telefono: tel, nombre: String(nombre || '').slice(0, 120), colonia: String(colonia || '').slice(0, 120),
            resultado, monto: Math.max(0, Number(monto) || 0), nota: String(nota || '').slice(0, 500),
            por: (req.admin && req.admin.usuario) || 'admin',
        });
        res.status(201).json(v);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Qué tan bien funcionan las visitas: resultados y cuántos volvieron a comprar después.
router.get('/resumen', async (req, res) => {
    try {
        const visitas = await Visita.find().sort({ createdAt: 1 }).lean();
        const tels = [...new Set(visitas.map((v) => v.telefono))];
        const pedidos = tels.length
            ? await Pedido.find({ createdAt: { $gte: visitas[0].createdAt } }, { telefono: 1, createdAt: 1 }).lean()
            : [];
        const comprasDe = new Map();
        for (const p of pedidos) {
            const t = normalizarTelefono(p.telefono);
            if (!tels.includes(t)) continue;
            if (!comprasDe.has(t)) comprasDe.set(t, []);
            comprasDe.get(t).push(new Date(p.createdAt).getTime());
        }
        // Por cliente cuenta su primera visita: ¿compró en los 28 días siguientes?
        const primera = new Map();
        for (const v of visitas) if (!primera.has(v.telefono)) primera.set(v.telefono, v);
        // `medibles` ya cumplieron sus 28 días: solo con ellos se calcula el porcentaje.
        let volvieron = 0, medibles = 0, volvieronMedibles = 0;
        for (const [t, v] of primera) {
            const desde = new Date(v.createdAt).getTime();
            const hasta = desde + DIAS_RETORNO * 864e5;
            const volvio = (comprasDe.get(t) || []).some((x) => x > desde && x <= hasta);
            if (volvio) volvieron++;
            if (Date.now() >= hasta) { medibles++; if (volvio) volvieronMedibles++; }
        }
        const porResultado = {};
        for (const v of visitas) porResultado[v.resultado] = (porResultado[v.resultado] || 0) + 1;
        res.json({
            visitas: visitas.length,
            clientes: primera.size,
            porResultado,
            vendidoEnVisita: visitas.reduce((a, v) => a + (v.monto || 0), 0),
            volvieron,
            medibles,
            volvieronMedibles,
            tasaRetorno: medibles ? Math.round((volvieronMedibles / medibles) * 100) : null,
            diasRetorno: DIAS_RETORNO,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
