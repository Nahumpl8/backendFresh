/**
 * Métricas de crecimiento: despensas por semana y recurrencia de clientes.
 *
 * Solo lee. No toca el flujo de pedidos ni nada de lo que dependa ManyChat.
 *
 *   GET /api/metricas/semanal?semanas=12
 *   GET /api/metricas/reactivacion
 *   GET /api/metricas/reactivacion/csv
 */

const router = require('express').Router();
const Pedido = require('../models/Pedidos');
const Clientes = require('../models/Clientes');
const M = require('../utils/metricas');
const { requireAdmin } = require('../utils/adminMiddleware');

const SEMANAS_MAX = 104;
const SEMANAS_DEFAULT = 12;

/**
 * Serie semanal. Las semanas van de lunes a domingo en hora de Pachuca y se
 * agrupan por createdAt (cuándo se vendió), no por la fecha de entrega.
 */
router.get('/semanal', async (req, res) => {
    try {
        const n = Math.min(Math.max(parseInt(req.query.semanas, 10) || SEMANAS_DEFAULT, 1), SEMANAS_MAX);
        const claves = M.ultimasSemanas(n);

        // La recurrencia de la primera semana reportada mira 4 semanas atrás, así
        // que hay que traer 3 semanas extra o saldría subestimada.
        const extra = M.SEMANAS_RECURRENCIA - 1;
        const desde = M.inicioDeClave(M.ultimasSemanas(n + extra)[0]);
        const hasta = M.finDeClave(claves[claves.length - 1]);

        const compras = await Pedido.aggregate(M.pipelineCompras({ desde, hasta })).allowDiskUse(true);
        compras.forEach((c) => { c.createdAt = new Date(c.createdAt); });

        const series = M.seriesSemanales(compras, claves);
        const fuentes = [...new Set(compras.map((c) => c.fuente))].sort();

        res.status(200).json({
            semanas: n,
            zonaHoraria: M.TZ,
            generado: new Date().toISOString(),
            criterio: {
                eje: 'createdAt (venta)',
                compra: `telefono + fecha de entrega + ventana de ${M.VENTANA_COMPRA_MIN} min`,
                venta: 'despensas (suma de despensaQuantity) + cestas propias (despensa "Pedido" sin despensa en la misma compra)',
                excluido: 'REPOSICION',
                clientesActivos: `al menos 1 compra en ${M.DIAS_ACTIVO} días`,
                recurrencia: `% de clientes con 2+ compras en ${M.SEMANAS_RECURRENCIA} semanas, al cierre de cada semana`,
            },
            fuentes,
            series,
        });
    } catch (err) {
        console.error('❌ /metricas/semanal:', err);
        res.status(500).json({ error: 'No se pudo calcular la serie semanal', detalle: err.message });
    }
});

/** Conteo de fichas por segmento de reactivación (lo rellena el backfill). */
router.get('/reactivacion', async (req, res) => {
    try {
        const filas = await Clientes.aggregate([
            { $group: { _id: '$segmentoReactivacion', clientes: { $sum: 1 }, totalGastado: { $sum: { $ifNull: ['$totalGastado', 0] } } } },
            { $sort: { clientes: -1 } },
        ]);
        const segmentos = filas
            .filter((f) => f._id)
            .map((f) => ({ segmento: f._id, clientes: f.clientes, totalGastado: Math.round(f.totalGastado) }));
        const sinSegmento = filas.find((f) => !f._id);

        res.status(200).json({
            segmentos,
            sinSegmento: sinSegmento ? sinSegmento.clientes : 0,
            total: filas.reduce((a, f) => a + f.clientes, 0),
            calculado: segmentos.length > 0,
        });
    } catch (err) {
        console.error('❌ /metricas/reactivacion:', err);
        res.status(500).json({ error: 'No se pudo contar los segmentos', detalle: err.message });
    }
});

/** Mismo listado en CSV, ordenado por totalGastado descendente. */
// Lleva nombre, teléfono y dirección: solo admin.
router.get('/reactivacion/csv', requireAdmin, async (req, res) => {
    try {
        const filtro = { segmentoReactivacion: { $ne: null } };
        if (req.query.segmento) filtro.segmentoReactivacion = req.query.segmento;

        const clientes = await Clientes.find(filtro)
            .select('nombre telefono segmentoReactivacion totalPedidos totalGastado direccion misDirecciones ultimaCompra')
            .sort({ totalGastado: -1 })
            .lean();

        const escapar = (v) => {
            const s = String(v ?? '');
            return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        // La "última dirección" es la más reciente de misDirecciones; si no hay,
        // la principal de la ficha.
        const ultimaDireccion = (c) => {
            const extra = Array.isArray(c.misDirecciones) && c.misDirecciones.length
                ? c.misDirecciones[c.misDirecciones.length - 1]
                : null;
            return (extra && extra.direccion) || c.direccion || '';
        };

        const cabecera = ['nombre', 'telefono', 'segmento', 'totalPedidos', 'totalGastado', 'ultimaDireccion'];
        const lineas = [cabecera.join(',')];
        for (const c of clientes) {
            lineas.push([
                escapar(c.nombre), escapar(c.telefono), escapar(c.segmentoReactivacion),
                c.totalPedidos || 0, Math.round(c.totalGastado || 0), escapar(ultimaDireccion(c)),
            ].join(','));
        }

        const nombre = `reactivacion_${new Date().toISOString().slice(0, 10)}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
        res.status(200).send('﻿' + lineas.join('\n')); // BOM: Excel abre los acentos bien
    } catch (err) {
        console.error('❌ /metricas/reactivacion/csv:', err);
        res.status(500).json({ error: 'No se pudo generar el CSV', detalle: err.message });
    }
});

module.exports = router;
