/**
 * Rutas de recuperación.
 *
 * El admin arma, por colonia y día, una ruta con clientes dormidos o perdidos y
 * se la asigna a un repartidor. El repartidor les deja un volante con regalo y
 * marca cada casa: no estaba, le dejó el volante, quiere pedir (se le pasa el
 * pedido a Shade por WhatsApp) o no le interesa.
 *
 * Un cliente deja de salir en las rutas cuando: quiere pedir, no le interesa, ya
 * se le visitó 2 veces sin que pidiera, o vuelve a comprar (deja de estar
 * dormido). Tampoco sale si ya está en otra ruta pendiente.
 *
 * La colonia sale del texto de la dirección del último pedido (lo que va antes
 * de la primera coma). Los pueblos quedan fuera: ahí se entrega en punto fijo.
 */
const router = require('express').Router();
const Pedido = require('../models/Pedidos');
const Clientes = require('../models/Clientes');
const Visita = require('../models/Visita');
const RutaRecuperacion = require('../models/RutaRecuperacion');
const Repartidor = require('../models/Repartidor');
const Config = require('../models/Config');
const { requireAdmin } = require('../utils/adminMiddleware');
const { normalizarTelefono } = require('../utils/metricas');

const PUEBLOS = /tizayuca|zapotlan|metztitl|acayuca|tolcayuca/;
const NO_ES_RUTA = /^(pasa a local|recoge|recoger|local)\b/;
const RESULTADOS = ['no_estaba', 'volante', 'quiere_pedir', 'no_interesa'];
const FINALES = ['quiere_pedir', 'no_interesa'];
const MAX_INTENTOS = 2;     // visitas sin pedir antes de sacarlo de las rutas
const DIAS_RETORNO = 28;    // "volvió" = compró dentro de 4 semanas después de la primera visita
const CLAVE_REGALO = 'recuperacionRegalo';
const CLAVE_WHATSAPP = 'recuperacionWhatsapp';
const WHATSAPP_DEFAULT = '527712346620';   // el WhatsApp del negocio, donde toma pedidos Shade

const hoyMX = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const sinAcento = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const claveColonia = (dir) => sinAcento(String(dir || '').split(',')[0])
    .replace(/^(col\.?|colonia|fracc?\.?|fraccionamiento|ampl\.?|ampliacion|priv\.?)\s+/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const soloAdmin = requireAdmin;
// El repartidor entra con su token (lo pone accesoApi); un admin también puede.
const repartidorOAdmin = (req, res, next) => (req.repartidor || req.admin ? next() : res.status(401).json({ error: 'No autorizado' }));

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

/** Teléfonos que ya no deben salir: cerrados por sus visitas o asignados a una ruta pendiente. */
async function fueraDeRutas() {
    const [porVisitas, pendientes] = await Promise.all([
        Visita.aggregate([{ $group: {
            _id: '$telefono',
            finales: { $sum: { $cond: [{ $in: ['$resultado', FINALES] }, 1, 0] } },
            intentos: { $sum: { $cond: [{ $in: ['$resultado', ['no_estaba', 'volante']] }, 1, 0] } },
        } }]),
        RutaRecuperacion.find({ fechaReparto: { $gte: hoyMX() } }, { casas: 1 }).lean(),
    ]);
    const fuera = new Set();
    for (const v of porVisitas) if (v.finales > 0 || v.intentos >= MAX_INTENTOS) fuera.add(v._id);
    for (const r of pendientes) for (const c of r.casas) if (!c.resultado) fuera.add(c.telefono);
    return fuera;
}

async function candidatos() {
    const [clientes, fuera] = await Promise.all([clientesNoActivos(), fueraDeRutas()]);
    return clientes.filter((c) => !fuera.has(c.telefono));
}

async function leerConfig() {
    const filas = await Config.find({ key: { $in: [CLAVE_REGALO, CLAVE_WHATSAPP] } }).lean();
    const v = (k) => ((filas.find((f) => f.key === k) || {}).value || '').trim();
    return { regalo: v(CLAVE_REGALO), whatsapp: v(CLAVE_WHATSAPP) || WHATSAPP_DEFAULT };
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

router.get('/config', soloAdmin, async (req, res) => {
    try { res.json(await leerConfig()); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/config', soloAdmin, async (req, res) => {
    try {
        const { regalo, whatsapp } = req.body || {};
        const set = (key, value) => Config.updateOne({ key }, { $set: { value: String(value).slice(0, 300) || ' ', updatedAt: new Date() } }, { upsert: true });
        if (regalo !== undefined) await set(CLAVE_REGALO, regalo);
        if (whatsapp !== undefined) {
            const tel = String(whatsapp).replace(/\D/g, '');
            if (tel.length < 10) return res.status(400).json({ error: 'El WhatsApp debe tener al menos 10 dígitos' });
            await set(CLAVE_WHATSAPP, tel.length === 10 ? '52' + tel : tel);
        }
        res.json(await leerConfig());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Colonias con clientes por recuperar, primero las que tienen más clientes fieles (3+ pedidos).
router.get('/colonias', soloAdmin, async (req, res) => {
    try {
        const col = {};
        for (const c of await candidatos()) {
            const k = (col[c.colonia] = col[c.colonia] || { colonia: c.colonia, total: 0, fieles: 0, en_riesgo: 0, dormido: 0, perdido: 0 });
            k.total++; k[c.segmento]++; if (c.pedidos >= 3) k.fieles++;
        }
        res.json(Object.values(col).filter((c) => c.total >= 5).sort((a, b) => b.fieles - a.fieles || b.total - a.total));
    } catch (err) {
        console.error('❌ reactivacion/colonias:', err.message);
        res.status(500).json({ error: 'No se pudieron calcular las colonias' });
    }
});

// Clientes por visitar de una colonia, con cuántas veces ya se les visitó.
router.get('/candidatos', soloAdmin, async (req, res) => {
    try {
        const colonia = String(req.query.colonia || '');
        const lista = (await candidatos()).filter((c) => c.colonia === colonia);
        const visitas = await Visita.aggregate([
            { $match: { telefono: { $in: lista.map((c) => c.telefono) } } },
            { $group: { _id: '$telefono', n: { $sum: 1 } } },
        ]);
        const veces = Object.fromEntries(visitas.map((v) => [v._id, v.n]));
        res.json(lista.map((c) => ({ ...c, visitas: veces[c.telefono] || 0 })));
    } catch (err) {
        console.error('❌ reactivacion/candidatos:', err.message);
        res.status(500).json({ error: 'No se pudo armar la lista' });
    }
});

router.get('/rutas', soloAdmin, async (req, res) => {
    try {
        const filtro = req.query.fecha ? { fechaReparto: String(req.query.fecha) } : { fechaReparto: { $gte: hoyMX() } };
        res.json(await RutaRecuperacion.find(filtro).sort({ fechaReparto: 1, repartidorNombre: 1 }).lean());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/rutas', soloAdmin, async (req, res) => {
    try {
        const { fechaReparto, repartidorId, colonia, telefonos } = req.body || {};
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fechaReparto || ''))) return res.status(400).json({ error: 'Fecha inválida' });
        if (fechaReparto < hoyMX()) return res.status(400).json({ error: 'La fecha ya pasó' });
        const rep = /^[a-f0-9]{24}$/i.test(String(repartidorId || '')) ? await Repartidor.findById(repartidorId).lean() : null;
        if (!rep) return res.status(400).json({ error: 'Elige un repartidor' });
        if (!Array.isArray(telefonos) || !telefonos.length) return res.status(400).json({ error: 'Elige al menos una casa' });

        const disponibles = new Map((await candidatos()).map((c) => [c.telefono, c]));
        const casas = [];
        let omitidas = 0;
        for (const t of telefonos.map(normalizarTelefono)) {
            const c = disponibles.get(t);
            if (!c) { omitidas++; continue; }
            casas.push({
                telefono: c.telefono, nombre: c.nombre, direccion: c.direccion, favorita: c.favorita,
                pedidos: c.pedidos, dias: c.dias, segmento: c.segmento,
            });
        }
        if (!casas.length) return res.status(409).json({ error: 'Esas casas ya no están disponibles (ya se asignaron o ya no son clientes por recuperar).' });

        const ruta = await RutaRecuperacion.create({
            fechaReparto, repartidorId: rep._id, repartidorNombre: rep.nombre,
            colonia: String(colonia || claveColonia(casas[0].direccion)).slice(0, 120),
            casas, creadaPor: (req.admin && req.admin.usuario) || 'admin',
        });
        console.log(`🔄 Ruta de recuperación: ${ruta.colonia} · ${ruta.fechaReparto} · ${rep.nombre} · ${casas.length} casas`);
        res.status(201).json({ ruta, omitidas });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/rutas/:id', soloAdmin, async (req, res) => {
    try {
        const r = await RutaRecuperacion.findByIdAndDelete(req.params.id);
        if (!r) return res.status(404).json({ error: 'No encontrada' });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Qué tan bien funcionan las visitas: resultados y cuántos volvieron a comprar después.
router.get('/resumen', soloAdmin, async (req, res) => {
    try {
        const visitas = await Visita.find().sort({ createdAt: 1 }).lean();
        const tels = new Set(visitas.map((v) => v.telefono));
        const pedidos = tels.size
            ? await Pedido.find({ createdAt: { $gte: visitas[0].createdAt } }, { telefono: 1, createdAt: 1 }).lean()
            : [];
        const comprasDe = new Map();
        for (const p of pedidos) {
            const t = normalizarTelefono(p.telefono);
            if (!tels.has(t)) continue;
            if (!comprasDe.has(t)) comprasDe.set(t, []);
            comprasDe.get(t).push(new Date(p.createdAt).getTime());
        }
        // Por cliente cuenta su primera visita. `medibles` ya cumplieron sus 28 días:
        // solo con ellos se calcula el porcentaje.
        const primera = new Map();
        for (const v of visitas) if (!primera.has(v.telefono)) primera.set(v.telefono, v);
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
            visitas: visitas.length, clientes: primera.size, porResultado,
            volvieron, medibles, volvieronMedibles,
            tasaRetorno: medibles ? Math.round((volvieronMedibles / medibles) * 100) : null,
            diasRetorno: DIAS_RETORNO,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Repartidor
// ---------------------------------------------------------------------------

// Sus rutas de recuperación de hoy, con el regalo del volante y el WhatsApp de pedidos.
router.get('/mi-ruta', repartidorOAdmin, async (req, res) => {
    try {
        const filtro = { fechaReparto: String(req.query.fecha || hoyMX()) };
        if (req.repartidor) filtro.repartidorId = req.repartidor.sub;
        else if (req.query.repartidorId) filtro.repartidorId = req.query.repartidorId;
        const [rutas, config] = await Promise.all([RutaRecuperacion.find(filtro).lean(), leerConfig()]);
        res.json({ rutas, ...config });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/mi-ruta/:id/marcar', repartidorOAdmin, async (req, res) => {
    try {
        const ruta = await RutaRecuperacion.findById(req.params.id);
        if (!ruta) return res.status(404).json({ error: 'Ruta no encontrada' });
        if (req.repartidor && String(ruta.repartidorId) !== String(req.repartidor.sub)) {
            return res.status(403).json({ error: 'Esta ruta no es tuya' });
        }
        const { telefono, resultado, nota } = req.body || {};
        if (!RESULTADOS.includes(resultado)) return res.status(400).json({ error: 'Resultado inválido' });
        const casa = ruta.casas.find((c) => c.telefono === normalizarTelefono(telefono));
        if (!casa) return res.status(404).json({ error: 'Esa casa no está en la ruta' });

        const yaMarcada = Boolean(casa.marcadoAt);
        casa.resultado = resultado;
        casa.nota = String(nota || '').slice(0, 500);
        casa.marcadoAt = new Date();
        ruta.markModified('casas');
        await ruta.save();
        const por = req.repartidor ? (req.repartidor.nombre || 'repartidor') : ((req.admin && req.admin.usuario) || 'admin');
        // Si corrige lo que marcó, se actualiza la misma visita: no cuenta como otra.
        const corregida = yaMarcada
            ? await Visita.findOneAndUpdate({ rutaId: ruta._id, telefono: casa.telefono }, { $set: { resultado, nota: casa.nota, por } })
            : null;
        if (!corregida) {
            await Visita.create({ telefono: casa.telefono, nombre: casa.nombre, colonia: ruta.colonia, resultado, nota: casa.nota, rutaId: ruta._id, por });
        }
        res.json(casa);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
