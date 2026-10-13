/**
 * Lógica de las métricas de crecimiento (despensas/semana y recurrencia).
 *
 * Separada de la ruta para poder probarla sin base de datos: todo lo que hay
 * aquí son funciones puras, salvo `pipelineCompras`, que solo *construye* el
 * pipeline (no lo ejecuta).
 *
 * Dos conceptos que no hay que confundir:
 *   - DOCUMENTO de pedido: una línea. El checkout parte cada compra en varios
 *     (uno por despensa + uno "Pedido" con los sueltos, ver buildPedidos.js en
 *     fresh-market-order).
 *   - COMPRA: lo que el cliente percibe como un pedido. Agrupa los documentos
 *     por teléfono + fecha de entrega + una ventana de tiempo.
 */

const TZ = 'America/Mexico_City';
const VENTANA_COMPRA_MIN = 120;   // ver comentario en agruparEnCompras
const DIAS_ACTIVO = 30;           // "clientes activos" = compraron en N días
const SEMANAS_RECURRENCIA = 4;    // ventana móvil de recurrencia
const DIAS_DORMIDO = 60;          // sin comprar => segmento "dormido"

// ---------------------------------------------------------------------------
// Semanas de lunes a domingo en hora de Pachuca
// ---------------------------------------------------------------------------
// México suprimió el horario de verano en 2022, así que hoy el offset es fijo
// (-06:00). Aun así resolvemos la zona con Intl en vez de restar 6 horas: si el
// horario de verano volviera, las semanas seguirían cortando donde deben.

const FMT = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

/** Componentes civiles (año, mes, día, hora...) de un instante, en hora de MX. */
function civilMX(date) {
    const p = {};
    for (const { type, value } of FMT.formatToParts(date)) p[type] = value;
    // hour12:false devuelve "24" para la medianoche en algunos runtimes
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

/** Milisegundos que hay que sumar a un "civil MX" para obtener el instante UTC. */
function offsetEn(date) {
    const c = civilMX(date);
    return date.getTime() - Date.UTC(c.y, c.m - 1, c.d, c.h, c.mi, c.s);
}

/**
 * Instante UTC correspondiente a una hora civil de México.
 * Se resuelve en dos pasos porque el offset depende del propio instante: la
 * primera pasada da una aproximación y la segunda la corrige si cayó al otro
 * lado de un cambio de horario.
 */
function instanteMX(y, m, d, h = 0, mi = 0, s = 0) {
    const tentativo = Date.UTC(y, m - 1, d, h, mi, s);
    const off1 = offsetEn(new Date(tentativo));
    const off2 = offsetEn(new Date(tentativo + off1));
    return new Date(tentativo + off2);
}

/** Lunes 00:00 (hora MX) de la semana a la que pertenece `date`. */
function inicioSemanaMX(date) {
    const c = civilMX(date);
    const dow = (new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay() + 6) % 7; // 0 = lunes
    return instanteMX(c.y, c.m, c.d - dow, 0, 0, 0);
}

/** Clave 'YYYY-MM-DD' del lunes de la semana (identifica la semana en las series). */
function claveSemana(date) {
    const c = civilMX(inicioSemanaMX(date));
    return `${c.y}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
}

/** Las `n` claves de semana que terminan en la semana de `ref` (incluida). */
function ultimasSemanas(n, ref = new Date()) {
    const out = [];
    let cursor = inicioSemanaMX(ref);
    for (let i = 0; i < n; i++) {
        out.unshift(claveSemana(cursor));
        // Retroceder 36 h desde el lunes 00:00 cae en el sábado anterior ~12:00;
        // al re-truncar da el lunes previo. Restar 7*24 h exactas sería frágil
        // si volviera el horario de verano (la semana puede durar 167 o 169 h).
        cursor = inicioSemanaMX(new Date(cursor.getTime() - 36 * 3600 * 1000));
    }
    return out;
}

/** Instante UTC en que empieza la semana identificada por la clave. */
function inicioDeClave(clave) {
    const [y, m, d] = clave.split('-').map(Number);
    return instanteMX(y, m, d, 0, 0, 0);
}

/** Instante UTC en que termina (exclusivo) la semana identificada por la clave. */
function finDeClave(clave) {
    const ini = inicioDeClave(clave);
    // +7 días y medio cae en el lunes siguiente por la tarde; truncar lo deja
    // en ese lunes a las 00:00. El medio día de holgura absorbe un eventual
    // cambio de horario sin saltarse una semana.
    return inicioSemanaMX(new Date(ini.getTime() + 7.5 * 86400000));
}

// ---------------------------------------------------------------------------
// Clasificación de documentos
// ---------------------------------------------------------------------------

/** Últimos 10 dígitos: en la BD conviven teléfonos con lada, espacios y guiones. */
function normalizarTelefono(tel) {
    const d = String(tel || '').replace(/\D/g, '');
    return d.length >= 10 ? d.slice(-10) : '';
}

/**
 * Qué representa un documento de pedido:
 *   'despensa'   -> cualquier despensa del catálogo, incluidas las temáticas
 *   'cesta'      -> despensa === 'Pedido': productos sueltos
 *   'reposicion' -> reposición de producto, no es venta
 */
function clasificarDocumento(despensa) {
    const n = String(despensa || '').trim().toLowerCase();
    if (n === 'pedido') return 'cesta';
    if (n === 'reposicion' || n === 'reposición') return 'reposicion';
    if (n === '') return 'reposicion'; // sin nombre no se puede contar como venta
    return 'despensa';
}

// ---------------------------------------------------------------------------
// Agrupación de documentos en compras
// ---------------------------------------------------------------------------

/**
 * Agrupa documentos de pedido en compras.
 *
 * Clave: teléfono normalizado + fecha de entrega, partiendo además cuando entre
 * dos documentos consecutivos pasan más de `ventanaMin` minutos. El teléfono y
 * la fecha de entrega por sí solos no bastan porque un cliente puede pedir dos
 * veces para el mismo día; medido sobre producción, el hueco entre documentos
 * de un mismo checkout tiene mediana de ~1 min y p90 de ~55 min, así que 120
 * min mantiene unido el checkout y separa las compras de verdad distintas.
 *
 * Los documentos de reposición se descartan antes de agrupar.
 *
 * Cada compra resultante:
 *   { tel, fecha, createdAt, despensas, cestaPropia, ingreso, fuente, docs }
 *
 * - `despensas`   suma despensaQuantity (una compra puede llevar 2 Familiares).
 * - `cestaPropia` vale 1 solo si el cliente NO llevó despensa: la cesta es la
 *   compra entera. Si vino junto a una despensa son los extras del checkout y
 *   no suma unidad, pero su importe sí entra en `ingreso`.
 */
function agruparEnCompras(docs, ventanaMin = VENTANA_COMPRA_MIN) {
    const ventanaMs = ventanaMin * 60000;
    const porClave = new Map();

    for (const d of docs) {
        if (clasificarDocumento(d.despensa) === 'reposicion') continue;
        const tel = normalizarTelefono(d.telefono);
        const clave = `${tel}|${d.fecha || ''}`;
        if (!porClave.has(clave)) porClave.set(clave, []);
        porClave.get(clave).push(d);
    }

    const compras = [];
    for (const [clave, arr] of porClave) {
        const tel = clave.slice(0, clave.indexOf('|'));
        const fecha = clave.slice(clave.indexOf('|') + 1);
        arr.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        let grupo = [];
        const cerrar = () => { if (grupo.length) compras.push(construirCompra(tel, fecha, grupo)); };
        for (const d of arr) {
            const prev = grupo[grupo.length - 1];
            if (prev && new Date(d.createdAt) - new Date(prev.createdAt) > ventanaMs) { cerrar(); grupo = []; }
            grupo.push(d);
        }
        cerrar();
    }
    compras.sort((a, b) => a.createdAt - b.createdAt);
    return compras;
}

function construirCompra(tel, fecha, docs) {
    let despensas = 0, tieneCesta = false, ingreso = 0;
    for (const d of docs) {
        const tipo = clasificarDocumento(d.despensa);
        if (tipo === 'despensa') despensas += Number(d.despensaQuantity) || 0;
        if (tipo === 'cesta') tieneCesta = true;
        ingreso += Number(d.total) || 0;
    }
    return {
        tel, fecha,
        createdAt: new Date(docs[0].createdAt),
        despensas,
        cestaPropia: despensas === 0 && tieneCesta ? 1 : 0,
        ingreso,
        fuente: docs[0].fuente || 'desconocido',
        docs: docs.length,
    };
}

/** Unidades vendidas de una compra: despensas + (1 si fue cesta propia). */
const ventasDeCompra = (c) => c.despensas + c.cestaPropia;

// ---------------------------------------------------------------------------
// Métricas
// ---------------------------------------------------------------------------

/**
 * Recurrencia al cierre de una semana: de los clientes que compraron en las
 * últimas `nSemanas`, qué porcentaje compró 2 o más veces en ese periodo.
 * Devuelve null si nadie compró (no es 0%: es que no hay a quién medir).
 */
function calcularRecurrencia(compras, claveCierre, nSemanas = SEMANAS_RECURRENCIA) {
    const fin = finDeClave(claveCierre);
    const ini = inicioDeClave(ultimasSemanas(nSemanas, inicioDeClave(claveCierre))[0]);

    const cuenta = new Map();
    for (const c of compras) {
        if (!c.tel) continue;
        if (c.createdAt < ini || c.createdAt >= fin) continue;
        cuenta.set(c.tel, (cuenta.get(c.tel) || 0) + 1);
    }
    const total = cuenta.size;
    if (total === 0) return { clientes: 0, recurrentes: 0, porcentaje: null };
    let recurrentes = 0;
    for (const n of cuenta.values()) if (n >= 2) recurrentes++;
    return {
        clientes: total,
        recurrentes,
        porcentaje: Math.round((recurrentes * 1000) / total) / 10,
    };
}

/** Clientes distintos con al menos una compra en los `dias` previos al cierre. */
function clientesActivos(compras, claveCierre, dias = DIAS_ACTIVO) {
    const fin = finDeClave(claveCierre);
    const ini = new Date(fin.getTime() - dias * 86400000);
    const s = new Set();
    for (const c of compras) {
        if (!c.tel) continue;
        if (c.createdAt >= ini && c.createdAt < fin) s.add(c.tel);
    }
    return s.size;
}

/**
 * Serie semanal completa. `claves` son las semanas a reportar (en orden).
 * `compras` debe cubrir además las 3 semanas previas a la primera clave, o la
 * recurrencia de esa primera semana saldrá subestimada.
 */
function seriesSemanales(compras, claves) {
    const vacio = () => ({ despensas: 0, cestasPropias: 0, compras: 0, ingresoTotal: 0, porFuente: {} });
    const acc = new Map(claves.map((k) => [k, vacio()]));

    for (const c of compras) {
        const k = claveSemana(c.createdAt);
        const w = acc.get(k);
        if (!w) continue; // compra fuera del rango reportado (sirve a la recurrencia)
        w.despensas += c.despensas;
        w.cestasPropias += c.cestaPropia;
        w.compras += 1;
        w.ingresoTotal += c.ingreso;
        w.porFuente[c.fuente] = (w.porFuente[c.fuente] || 0) + 1;
    }

    return claves.map((k) => {
        const w = acc.get(k);
        const rec = calcularRecurrencia(compras, k);
        return {
            semana: k,
            inicio: inicioDeClave(k).toISOString(),
            fin: finDeClave(k).toISOString(),
            ventasSemana: w.despensas + w.cestasPropias,
            despensas: w.despensas,
            cestasPropias: w.cestasPropias,
            compras: w.compras,
            ingresoTotal: Math.round(w.ingresoTotal),
            ticketPromedio: w.compras ? Math.round(w.ingresoTotal / w.compras) : 0,
            clientesActivos: clientesActivos(compras, k),
            recurrencia: rec.porcentaje,
            recurrenciaDetalle: rec,
            porFuente: w.porFuente,
        };
    });
}

// ---------------------------------------------------------------------------
// Pipeline de agregación: documentos -> compras
// ---------------------------------------------------------------------------

/** Últimos 10 dígitos de $telefono, dentro del pipeline. */
const EXPR_TELEFONO = {
    $let: {
        vars: {
            d: {
                $reduce: {
                    input: { $regexFindAll: { input: { $ifNull: ['$telefono', ''] }, regex: /\d/ } },
                    initialValue: '',
                    in: { $concat: ['$$value', '$$this.match'] },
                },
            },
        },
        in: {
            $cond: [
                { $gte: [{ $strLenCP: '$$d' }, 10] },
                { $substrCP: ['$$d', { $subtract: [{ $strLenCP: '$$d' }, 10] }, 10] },
                '',
            ],
        },
    },
};

/**
 * Pipeline que convierte documentos de pedido en compras, con el mismo criterio
 * que `agruparEnCompras`. Se hace en Mongo (y no en Node) para no traerse la
 * colección entera: el $match inicial usa el índice de createdAt.
 */
function pipelineCompras({ desde, hasta, ventanaMin = VENTANA_COMPRA_MIN }) {
    const particion = { tel: '$_tel', fecha: '$_fecha' };
    return [
        { $match: { createdAt: { $gte: desde, $lt: hasta } } },
        {
            $addFields: {
                _tel: EXPR_TELEFONO,
                _fecha: { $ifNull: ['$fecha', ''] },
                _tipo: {
                    $let: {
                        vars: { n: { $toLower: { $trim: { input: { $ifNull: ['$despensa', ''] } } } } },
                        in: {
                            $switch: {
                                branches: [
                                    { case: { $eq: ['$$n', 'pedido'] }, then: 'cesta' },
                                    { case: { $in: ['$$n', ['reposicion', 'reposición', '']] }, then: 'reposicion' },
                                ],
                                default: 'despensa',
                            },
                        },
                    },
                },
            },
        },
        { $match: { _tipo: { $ne: 'reposicion' } } },
        {
            $setWindowFields: {
                partitionBy: particion,
                sortBy: { createdAt: 1 },
                output: { _prev: { $shift: { output: '$createdAt', by: -1 } } },
            },
        },
        {
            $addFields: {
                _nueva: {
                    $cond: [
                        {
                            $or: [
                                { $eq: [{ $ifNull: ['$_prev', null] }, null] },
                                { $gt: [{ $subtract: ['$createdAt', '$_prev'] }, ventanaMin * 60000] },
                            ],
                        },
                        1, 0,
                    ],
                },
            },
        },
        {
            $setWindowFields: {
                partitionBy: particion,
                sortBy: { createdAt: 1 },
                output: { _idx: { $sum: '$_nueva', window: { documents: ['unbounded', 'current'] } } },
            },
        },
        {
            $group: {
                _id: { tel: '$_tel', fecha: '$_fecha', idx: '$_idx' },
                createdAt: { $min: '$createdAt' },
                despensas: { $sum: { $cond: [{ $eq: ['$_tipo', 'despensa'] }, { $ifNull: ['$despensaQuantity', 0] }, 0] } },
                tieneCesta: { $max: { $cond: [{ $eq: ['$_tipo', 'cesta'] }, 1, 0] } },
                ingreso: { $sum: { $ifNull: ['$total', 0] } },
                fuente: { $top: { output: { $ifNull: ['$fuente', 'desconocido'] }, sortBy: { createdAt: 1 } } },
                docs: { $sum: 1 },
            },
        },
        {
            $project: {
                _id: 0,
                tel: '$_id.tel',
                fecha: '$_id.fecha',
                createdAt: 1,
                despensas: 1,
                cestaPropia: { $cond: [{ $and: [{ $eq: ['$despensas', 0] }, { $eq: ['$tieneCesta', 1] }] }, 1, 0] },
                ingreso: 1,
                fuente: 1,
                docs: 1,
            },
        },
        { $sort: { createdAt: 1 } },
    ];
}

module.exports = {
    TZ, VENTANA_COMPRA_MIN, DIAS_ACTIVO, SEMANAS_RECURRENCIA, DIAS_DORMIDO,
    civilMX, instanteMX, inicioSemanaMX, claveSemana, ultimasSemanas, inicioDeClave, finDeClave,
    normalizarTelefono, clasificarDocumento,
    agruparEnCompras, ventasDeCompra,
    calcularRecurrencia, clientesActivos, seriesSemanales,
    pipelineCompras,
};
