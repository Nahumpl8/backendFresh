/**
 * Pruebas de la lógica de métricas. Sin base de datos: todo lo que se prueba
 * aquí son las funciones puras de utils/metricas.js.
 *
 *   node --test test/
 */

const test = require('node:test');
const assert = require('node:assert');
const m = require('../utils/metricas');

// Hora de Pachuca = UTC-6 (México no usa horario de verano desde 2022).
// Para leer las fechas de abajo: 06:00Z == 00:00 del mismo día en MX.
const mx = (iso) => new Date(iso);

// ---------------------------------------------------------------------------
test('corte de semana: lunes a domingo en hora de México', async (t) => {
    await t.test('domingo 23:59:59 MX sigue siendo la semana que termina', () => {
        // domingo 4 oct 2026, 23:59:59 MX = 5 oct 05:59:59 UTC
        assert.strictEqual(m.claveSemana(mx('2026-10-05T05:59:59Z')), '2026-09-28');
    });

    await t.test('lunes 00:00:00 MX ya es la semana siguiente', () => {
        // lunes 5 oct 2026, 00:00:00 MX = 5 oct 06:00:00 UTC
        assert.strictEqual(m.claveSemana(mx('2026-10-05T06:00:00Z')), '2026-10-05');
    });

    await t.test('un segundo antes del lunes MX no cruza de semana', () => {
        assert.strictEqual(m.claveSemana(mx('2026-10-05T05:59:59.999Z')), '2026-09-28');
        assert.strictEqual(m.claveSemana(mx('2026-10-05T06:00:00.001Z')), '2026-10-05');
    });

    await t.test('domingo a medianoche UTC todavía es sábado en MX', () => {
        // 4 oct 00:00 UTC = 3 oct 18:00 MX (sábado): semana del 28 sep
        assert.strictEqual(m.claveSemana(mx('2026-10-04T00:00:00Z')), '2026-09-28');
    });

    await t.test('el lunes mismo pertenece a su propia semana', () => {
        assert.strictEqual(m.claveSemana(mx('2026-09-28T12:00:00Z')), '2026-09-28');
    });

    await t.test('inicio y fin de una semana son lunes 00:00 MX', () => {
        assert.strictEqual(m.inicioDeClave('2026-09-28').toISOString(), '2026-09-28T06:00:00.000Z');
        assert.strictEqual(m.finDeClave('2026-09-28').toISOString(), '2026-10-05T06:00:00.000Z');
    });

    await t.test('el cambio de año no rompe la numeración', () => {
        // jueves 1 ene 2026 cae en la semana que arrancó el lunes 29 dic 2025
        assert.strictEqual(m.claveSemana(mx('2026-01-01T12:00:00Z')), '2025-12-29');
    });

    await t.test('ultimasSemanas devuelve n claves consecutivas y ordenadas', () => {
        const s = m.ultimasSemanas(4, mx('2026-10-01T12:00:00Z'));
        assert.deepStrictEqual(s, ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
    });
});

// ---------------------------------------------------------------------------
test('agrupación de documentos en compras', async (t) => {
    const doc = (o) => ({
        telefono: '7711234567', fecha: 'sábado, 3 Octubre 2026',
        despensa: 'Familiar', despensaQuantity: 1, total: 285, ...o,
    });

    await t.test('los documentos de un mismo checkout forman una compra', () => {
        const compras = m.agruparEnCompras([
            doc({ createdAt: mx('2026-10-01T18:00:00Z') }),
            doc({ createdAt: mx('2026-10-01T18:00:40Z'), despensa: 'Premium', total: 485 }),
        ]);
        assert.strictEqual(compras.length, 1);
        assert.strictEqual(compras[0].despensas, 2);
        assert.strictEqual(compras[0].ingreso, 770);
    });

    await t.test('más de 2 h de separación son dos compras distintas', () => {
        const compras = m.agruparEnCompras([
            doc({ createdAt: mx('2026-10-01T18:00:00Z') }),
            doc({ createdAt: mx('2026-10-01T21:00:00Z') }),
        ]);
        assert.strictEqual(compras.length, 2);
    });

    await t.test('justo en el límite de la ventana sigue siendo la misma compra', () => {
        const compras = m.agruparEnCompras([
            doc({ createdAt: mx('2026-10-01T18:00:00Z') }),
            doc({ createdAt: mx('2026-10-01T20:00:00Z') }), // exactamente 120 min
        ]);
        assert.strictEqual(compras.length, 1);
    });

    await t.test('la ventana se mide entre documentos consecutivos, no contra el primero', () => {
        // 0 -> 90 -> 180 min: cadena continua, una sola compra
        const compras = m.agruparEnCompras([
            doc({ createdAt: mx('2026-10-01T18:00:00Z') }),
            doc({ createdAt: mx('2026-10-01T19:30:00Z') }),
            doc({ createdAt: mx('2026-10-01T21:00:00Z') }),
        ]);
        assert.strictEqual(compras.length, 1);
        assert.strictEqual(compras[0].docs, 3);
    });

    await t.test('distinta fecha de entrega son compras distintas aunque sea el mismo minuto', () => {
        const compras = m.agruparEnCompras([
            doc({ createdAt: mx('2026-10-01T18:00:00Z'), fecha: 'sábado, 3 Octubre 2026' }),
            doc({ createdAt: mx('2026-10-01T18:00:10Z'), fecha: 'domingo, 4 Octubre 2026' }),
        ]);
        assert.strictEqual(compras.length, 2);
    });

    await t.test('teléfonos con lada o guiones son el mismo cliente', () => {
        const compras = m.agruparEnCompras([
            doc({ createdAt: mx('2026-10-01T18:00:00Z'), telefono: '771 123 4567' }),
            doc({ createdAt: mx('2026-10-01T18:00:30Z'), telefono: '+52 7711234567' }),
        ]);
        assert.strictEqual(compras.length, 1);
    });
});

// ---------------------------------------------------------------------------
test('qué cuenta como venta', async (t) => {
    const base = { telefono: '7711234567', fecha: 'sábado, 3 Octubre 2026', createdAt: mx('2026-10-01T18:00:00Z') };

    await t.test('despensaQuantity se suma, no se cuentan documentos', () => {
        const [c] = m.agruparEnCompras([{ ...base, despensa: 'Familiar', despensaQuantity: 3, total: 855 }]);
        assert.strictEqual(c.despensas, 3);
        assert.strictEqual(m.ventasDeCompra(c), 3);
    });

    await t.test('las despensas temáticas cuentan como despensa', () => {
        for (const n of ['Parrillera', 'Saludable', 'Mexicano', 'NAVIDEÑO', 'Futbolera', 'Felices Fiestas', 'Fiestas Patrias', 'Nochebuena']) {
            assert.strictEqual(m.clasificarDocumento(n), 'despensa', `${n} debería ser despensa`);
        }
    });

    await t.test('el nombre se compara sin distinguir mayúsculas ni espacios', () => {
        assert.strictEqual(m.clasificarDocumento('  PEDIDO '), 'cesta');
        assert.strictEqual(m.clasificarDocumento('Reposicion'), 'reposicion');
        assert.strictEqual(m.clasificarDocumento('REPOSICIÓN'), 'reposicion');
        assert.strictEqual(m.clasificarDocumento('familiar'), 'despensa');
    });

    await t.test('"Pedido" solo es una venta cuando el cliente no llevó despensa', () => {
        const [cesta] = m.agruparEnCompras([{ ...base, despensa: 'Pedido', despensaQuantity: 1, total: 320 }]);
        assert.strictEqual(cesta.cestaPropia, 1);
        assert.strictEqual(m.ventasDeCompra(cesta), 1);
    });

    await t.test('"Pedido" junto a una despensa no suma unidad, pero sí ingreso', () => {
        const [c] = m.agruparEnCompras([
            { ...base, despensa: 'Familiar', despensaQuantity: 1, total: 285 },
            { ...base, createdAt: mx('2026-10-01T18:00:20Z'), despensa: 'Pedido', despensaQuantity: 1, total: 120 },
        ]);
        assert.strictEqual(c.despensas, 1);
        assert.strictEqual(c.cestaPropia, 0, 'los extras no son una cesta propia');
        assert.strictEqual(m.ventasDeCompra(c), 1);
        assert.strictEqual(c.ingreso, 405, 'el importe de los extras sí cuenta');
    });

    await t.test('REPOSICION se excluye por completo', () => {
        const compras = m.agruparEnCompras([{ ...base, despensa: 'REPOSICION', despensaQuantity: 1, total: 0 }]);
        assert.strictEqual(compras.length, 0, 'una reposición sola no es una compra');

        const [c] = m.agruparEnCompras([
            { ...base, despensa: 'Familiar', despensaQuantity: 1, total: 285 },
            { ...base, createdAt: mx('2026-10-01T18:00:20Z'), despensa: 'REPOSICION', despensaQuantity: 1, total: 50 },
        ]);
        assert.strictEqual(c.despensas, 1);
        assert.strictEqual(c.ingreso, 285, 'el importe de la reposición no entra al ingreso');
    });
});

// ---------------------------------------------------------------------------
test('recurrencia', async (t) => {
    const compra = (tel, iso) => ({
        tel, createdAt: mx(iso), despensas: 1, cestaPropia: 0, ingreso: 285, fuente: 'desconocido', docs: 1,
    });
    // Semana de cierre 2026-09-28 => ventana de 4 semanas: 2026-09-07 .. 2026-10-04 (MX)

    await t.test('un cliente con una sola compra no es recurrente', () => {
        const r = m.calcularRecurrencia([compra('7711111111', '2026-09-29T18:00:00Z')], '2026-09-28');
        assert.deepStrictEqual(r, { clientes: 1, recurrentes: 0, porcentaje: 0 });
    });

    await t.test('un cliente con dos compras en la ventana es recurrente', () => {
        const r = m.calcularRecurrencia([
            compra('7711111111', '2026-09-10T18:00:00Z'),
            compra('7711111111', '2026-09-29T18:00:00Z'),
        ], '2026-09-28');
        assert.deepStrictEqual(r, { clientes: 1, recurrentes: 1, porcentaje: 100 });
    });

    await t.test('dos compras el mismo día cuentan como dos', () => {
        // son compras ya separadas por la ventana de 2 h: el cliente pidió dos veces
        const r = m.calcularRecurrencia([
            compra('7711111111', '2026-09-29T18:00:00Z'),
            compra('7711111111', '2026-09-29T23:00:00Z'),
        ], '2026-09-28');
        assert.strictEqual(r.porcentaje, 100);
    });

    await t.test('porcentaje sobre varios clientes', () => {
        const r = m.calcularRecurrencia([
            compra('7711111111', '2026-09-10T18:00:00Z'),
            compra('7711111111', '2026-09-29T18:00:00Z'), // recurrente
            compra('7712222222', '2026-09-29T18:00:00Z'), // una sola
            compra('7713333333', '2026-09-15T18:00:00Z'),
            compra('7713333333', '2026-09-22T18:00:00Z'), // recurrente
            compra('7714444444', '2026-09-30T18:00:00Z'), // una sola
        ], '2026-09-28');
        assert.strictEqual(r.clientes, 4);
        assert.strictEqual(r.recurrentes, 2);
        assert.strictEqual(r.porcentaje, 50);
    });

    await t.test('las compras fuera de la ventana de 4 semanas no cuentan', () => {
        const r = m.calcularRecurrencia([
            compra('7711111111', '2026-08-20T18:00:00Z'), // anterior a la ventana
            compra('7711111111', '2026-09-29T18:00:00Z'),
        ], '2026-09-28');
        assert.strictEqual(r.recurrentes, 0, 'solo una compra cae dentro de la ventana');
        assert.strictEqual(r.porcentaje, 0);
    });

    await t.test('el domingo final de la ventana entra; el lunes siguiente no', () => {
        const dentro = m.calcularRecurrencia([
            compra('7711111111', '2026-09-10T18:00:00Z'),
            compra('7711111111', '2026-10-05T05:59:59Z'), // domingo 23:59:59 MX
        ], '2026-09-28');
        assert.strictEqual(dentro.recurrentes, 1);

        const fuera = m.calcularRecurrencia([
            compra('7711111111', '2026-09-10T18:00:00Z'),
            compra('7711111111', '2026-10-05T06:00:00Z'), // lunes 00:00 MX
        ], '2026-09-28');
        assert.strictEqual(fuera.recurrentes, 0);
    });

    await t.test('sin compras en la ventana el porcentaje es null, no 0', () => {
        const r = m.calcularRecurrencia([], '2026-09-28');
        assert.strictEqual(r.porcentaje, null);
    });

    await t.test('los pedidos sin teléfono usable se ignoran', () => {
        const r = m.calcularRecurrencia([
            { ...compra('7711111111', '2026-09-29T18:00:00Z') },
            { ...compra('', '2026-09-29T18:00:00Z') },
        ], '2026-09-28');
        assert.strictEqual(r.clientes, 1);
    });
});

// ---------------------------------------------------------------------------
test('clientes activos', async (t) => {
    const compra = (tel, iso) => ({ tel, createdAt: mx(iso), despensas: 1, cestaPropia: 0, ingreso: 285, fuente: 'web', docs: 1 });

    await t.test('cuenta clientes distintos de los últimos 30 días', () => {
        const n = m.clientesActivos([
            compra('7711111111', '2026-09-29T18:00:00Z'),
            compra('7711111111', '2026-09-20T18:00:00Z'), // mismo cliente
            compra('7712222222', '2026-09-15T18:00:00Z'),
        ], '2026-09-28');
        assert.strictEqual(n, 2);
    });

    await t.test('fuera de los 30 días no cuenta', () => {
        // ventana: 2026-09-05T06:00Z .. 2026-10-05T06:00Z
        const n = m.clientesActivos([compra('7711111111', '2026-09-04T18:00:00Z')], '2026-09-28');
        assert.strictEqual(n, 0);
    });
});

// ---------------------------------------------------------------------------
test('serie semanal', async (t) => {
    await t.test('reparte las compras en su semana y calcula los totales', () => {
        const compras = m.agruparEnCompras([
            { telefono: '7711111111', fecha: 'f1', createdAt: mx('2026-09-22T18:00:00Z'), despensa: 'Familiar', despensaQuantity: 2, total: 570 },
            { telefono: '7712222222', fecha: 'f2', createdAt: mx('2026-09-29T18:00:00Z'), despensa: 'Premium', despensaQuantity: 1, total: 485 },
            { telefono: '7713333333', fecha: 'f3', createdAt: mx('2026-09-30T18:00:00Z'), despensa: 'Pedido', despensaQuantity: 1, total: 300 },
        ]);
        const serie = m.seriesSemanales(compras, ['2026-09-21', '2026-09-28']);

        assert.strictEqual(serie[0].semana, '2026-09-21');
        assert.strictEqual(serie[0].despensas, 2);
        assert.strictEqual(serie[0].ventasSemana, 2);

        assert.strictEqual(serie[1].semana, '2026-09-28');
        assert.strictEqual(serie[1].despensas, 1);
        assert.strictEqual(serie[1].cestasPropias, 1);
        assert.strictEqual(serie[1].ventasSemana, 2, 'despensas + cestas propias');
        assert.strictEqual(serie[1].compras, 2);
        assert.strictEqual(serie[1].ticketPromedio, 393, '(485+300)/2');
    });

    await t.test('una semana sin compras sale en cero, no se omite', () => {
        const serie = m.seriesSemanales([], ['2026-09-21', '2026-09-28']);
        assert.strictEqual(serie.length, 2);
        assert.strictEqual(serie[0].ventasSemana, 0);
        assert.strictEqual(serie[0].ticketPromedio, 0);
        assert.strictEqual(serie[0].recurrencia, null);
    });
});
