/**
 * Backfill de los campos de medición (plan de crecimiento).
 *
 * Rellena, sin borrar ni pisar nada que ya tenga valor:
 *
 *   Pedido.fuente       <- derivado de `via` (ver MAPEO_VIA)
 *   Cliente.ultimaCompra<- createdAt del pedido más reciente de ese teléfono
 *   Cliente.fechaAlta   <- createdAt de la ficha, donde falte
 *   Cliente.segmentoReactivacion <- pre_registro_con_compras | pre_registro_sin_rastro | dormido | null
 *
 * NO toca `email`: el esquema declara un índice unique+sparse sobre ese campo y
 * escribir null explícito en las ~7,500 fichas que hoy no lo tienen las haría
 * indexables y colisionarían entre sí. Ver NOTA-EMAIL.md.
 *
 * Es idempotente: correrlo dos veces seguidas deja la segunda sin nada que hacer
 * (salvo lo que haya cambiado en la BD entre una corrida y otra).
 *
 * Uso:
 *   node scripts/backfillMetricas.js             -> DRY RUN (no escribe nada)
 *   APPLY=1 node scripts/backfillMetricas.js     -> aplica los cambios
 *
 *   SOLO=fuente|clientes|segmentos               -> limita a una fase
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Pedido = require('../models/Pedidos');
const Clientes = require('../models/Clientes');
const { normalizarTelefono, clasificarDocumento, DIAS_DORMIDO } = require('../utils/metricas');

dotenv.config();

const DRY_RUN = process.env.APPLY !== '1';
const SOLO = process.env.SOLO || '';
const LOTE = 1000;

// Fichas anteriores a esta fecha son previas al registro de pedidos: la
// colección `pedidos` arranca el 3 nov 2025.
const INICIO_REGISTRO = new Date('2025-11-01T00:00:00Z');

/**
 * `via` -> `fuente`.
 *   null  : pedidos anteriores al 21 jul 2026, cuando el campo via no existía.
 *   ''    : capturados en el panel. Operativamente casi todos llegan por
 *           WhatsApp, pero el dato no está registrado: no lo inventamos.
 *   'web' : freshmarket.mx.
 */
const MAPEO_VIA = {
    web: 'web',
    whatsapp: 'whatsapp',
    telegram: 'telegram',
    email: 'email',
    anuncio: 'anuncio',
};
const fuenteDesdeVia = (via) => MAPEO_VIA[String(via || '').trim().toLowerCase()] || 'desconocido';

const log = (...a) => console.log(...a);
const sep = () => log('─'.repeat(72));

// ---------------------------------------------------------------------------
async function fasePedidos() {
    sep();
    log('1) Pedido.fuente');

    const pendientes = await Pedido.countDocuments({ fuente: { $exists: false } });
    const total = await Pedido.countDocuments();
    log(`   pedidos totales: ${total} | sin campo fuente: ${pendientes}`);

    const porVia = await Pedido.aggregate([
        { $match: { fuente: { $exists: false } } },
        { $group: { _id: '$via', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
    ]);
    if (!porVia.length) { log('   nada que hacer'); return; }

    log('   via actual        ->  fuente        documentos');
    const plan = [];
    for (const { _id, n } of porVia) {
        const fuente = fuenteDesdeVia(_id);
        log(`   ${JSON.stringify(_id).padEnd(16)} ->  ${fuente.padEnd(12)}  ${n}`);
        plan.push({ via: _id, fuente, n });
    }

    if (DRY_RUN) { log(`   [DRY RUN] se actualizarían ${pendientes} pedidos`); return; }

    let hechos = 0;
    for (const { via, fuente } of plan) {
        const filtro = { fuente: { $exists: false }, via: via === null ? { $in: [null] } : via };
        const r = await Pedido.updateMany(filtro, { $set: { fuente } });
        hechos += r.modifiedCount;
        log(`   ✔ ${fuente}: ${r.modifiedCount}`);
    }
    log(`   total actualizado: ${hechos}`);
}

// ---------------------------------------------------------------------------
/** Mapa teléfono -> { ultimaCompra, compras } a partir de la colección de pedidos. */
async function resumenPorTelefono() {
    const mapa = new Map();
    const cursor = Pedido.find({}, { telefono: 1, createdAt: 1, despensa: 1 }).lean().cursor();
    for await (const d of cursor) {
        // Una reposición no es una compra: no debe revivir a un cliente dormido.
        if (clasificarDocumento(d.despensa) === 'reposicion') continue;
        const tel = normalizarTelefono(d.telefono);
        if (!tel) continue;
        const prev = mapa.get(tel);
        if (!prev) mapa.set(tel, { ultimaCompra: d.createdAt, compras: 1 });
        else {
            prev.compras++;
            if (d.createdAt > prev.ultimaCompra) prev.ultimaCompra = d.createdAt;
        }
    }
    return mapa;
}

async function faseClientes(resumen) {
    sep();
    log('2) Cliente.ultimaCompra y Cliente.fechaAlta');

    const clientes = await Clientes.find({}, { telefono: 1, createdAt: 1, ultimaCompra: 1, fechaAlta: 1 }).lean();
    log(`   clientes: ${clientes.length} | teléfonos con compras: ${resumen.size}`);

    const ops = [];
    let nUltima = 0, nAlta = 0, sinCompras = 0;
    for (const c of clientes) {
        const set = {};
        const tel = normalizarTelefono(c.telefono);
        const r = tel ? resumen.get(tel) : null;

        if (r) {
            const actual = c.ultimaCompra ? new Date(c.ultimaCompra).getTime() : null;
            if (actual !== new Date(r.ultimaCompra).getTime()) { set.ultimaCompra = r.ultimaCompra; nUltima++; }
        } else sinCompras++;

        if (!c.fechaAlta && c.createdAt) { set.fechaAlta = c.createdAt; nAlta++; }

        if (Object.keys(set).length) ops.push({ updateOne: { filter: { _id: c._id }, update: { $set: set } } });
    }

    log(`   ultimaCompra a escribir : ${nUltima}`);
    log(`   fechaAlta a escribir    : ${nAlta}`);
    log(`   fichas sin compras      : ${sinCompras}`);

    if (DRY_RUN) { log(`   [DRY RUN] se tocarían ${ops.length} documentos`); return; }
    await ejecutarLotes(ops);
}

// ---------------------------------------------------------------------------
async function faseSegmentos(resumen) {
    sep();
    log('3) Cliente.segmentoReactivacion');

    const corte = new Date(Date.now() - DIAS_DORMIDO * 86400000);
    log(`   "dormido" = sin compras desde ${corte.toISOString().slice(0, 10)} (${DIAS_DORMIDO} días)`);

    const clientes = await Clientes.find({}, {
        telefono: 1, createdAt: 1, totalPedidos: 1, totalGastado: 1, segmentoReactivacion: 1,
    }).lean();

    const cuenta = {};
    const ops = [];
    for (const c of clientes) {
        const tel = normalizarTelefono(c.telefono);
        const r = tel ? resumen.get(tel) : null;
        const previa = c.createdAt && c.createdAt < INICIO_REGISTRO;
        const conRastro = (c.totalPedidos || 0) > 0 || (c.totalGastado || 0) > 0;

        let seg = null;
        if (!r) {
            if (previa) seg = conRastro ? 'pre_registro_con_compras' : 'pre_registro_sin_rastro';
        } else if (r.ultimaCompra < corte) {
            seg = 'dormido';
        }

        cuenta[seg === null ? '(null)' : seg] = (cuenta[seg === null ? '(null)' : seg] || 0) + 1;
        const actual = c.segmentoReactivacion ?? null;
        if (actual !== seg) ops.push({ updateOne: { filter: { _id: c._id }, update: { $set: { segmentoReactivacion: seg } } } });
    }

    log('   segmento                    clientes');
    for (const [k, v] of Object.entries(cuenta).sort((a, b) => b[1] - a[1])) log(`   ${k.padEnd(28)} ${v}`);
    log(`   documentos que cambian: ${ops.length}`);

    if (DRY_RUN) { log(`   [DRY RUN] se tocarían ${ops.length} documentos`); return; }
    await ejecutarLotes(ops);
}

// ---------------------------------------------------------------------------
async function ejecutarLotes(ops) {
    if (!ops.length) { log('   nada que escribir'); return; }
    let hechos = 0;
    for (let i = 0; i < ops.length; i += LOTE) {
        const r = await Clientes.bulkWrite(ops.slice(i, i + LOTE), { ordered: false });
        hechos += r.modifiedCount;
        log(`   ✔ ${Math.min(i + LOTE, ops.length)}/${ops.length}`);
    }
    log(`   modificados: ${hechos}`);
}

// ---------------------------------------------------------------------------
(async () => {
    if (!process.env.MONGO_URL) { console.error('Falta MONGO_URL'); process.exit(1); }
    await mongoose.connect(process.env.MONGO_URL);

    sep();
    log(DRY_RUN
        ? '🔍 DRY RUN — no se escribe nada. Para aplicar: APPLY=1 node scripts/backfillMetricas.js'
        : '✍️  APLICANDO CAMBIOS EN LA BASE DE DATOS');
    if (SOLO) log(`   fase única: ${SOLO}`);

    if (!SOLO || SOLO === 'fuente') await fasePedidos();

    if (!SOLO || SOLO === 'clientes' || SOLO === 'segmentos') {
        log('\n   leyendo pedidos para resumir por teléfono…');
        const resumen = await resumenPorTelefono();
        if (!SOLO || SOLO === 'clientes') await faseClientes(resumen);
        if (!SOLO || SOLO === 'segmentos') await faseSegmentos(resumen);
    }

    sep();
    log(DRY_RUN ? '🔍 DRY RUN terminado — la base de datos NO se tocó.' : '✅ Backfill aplicado.');
    await mongoose.disconnect();
})().catch(async (e) => {
    console.error('❌ Error:', e);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
