/**
 * Pruebas del cálculo de pedidos por chat. Sin base de datos ni IA.
 *   node --test test/
 */
const test = require('node:test');
const assert = require('node:assert');
const T = require('../utils/telegramPedidos');

// Catálogo de juguete con la misma forma que el real
const productos = [
    { _id: 'a1', title: '1kg de Jitomate $28', price: 28, minUnit: 1, unit: 'kg', categories: ['Verduras'] },
    { _id: 'a2', title: '1 Kg pechuga aplanada $160', price: 160, minUnit: 1, unit: 'Kg', categories: ['Pollo'] },
    { _id: 'a3', title: '1kg de Aguacate $68', price: 68, minUnit: 1, unit: 'kg', categories: ['Verduras'] },
    { _id: 'a4', title: '1kg de Limón $20', price: 20, minUnit: 1, unit: 'kg', categories: ['Verduras'] },
    { _id: 'a5', title: 'Producto oculto', price: 50, minUnit: 1, unit: 'pz', showInWeb: false },
    { _id: 'a6', title: 'Producto agotado', price: 50, minUnit: 1, unit: 'pz', inStock: false },
];
const despensas = [{
    _id: 'd1', name: 'Familiar', price: 285, allowChanges: true,
    products: [
        { productId: { _id: 'a1', title: '1kg de Jitomate $28', price: 28 }, cantidad: 1, unidad: 'kg' },
        { productId: { _id: 'a3', title: '1kg de Aguacate $68', price: 68 }, cantidad: 1, unidad: 'kg' },
        { productId: { _id: 'a4', title: '1kg de Limón $20', price: 20 }, cantidad: 1, unidad: 'kg' },
    ],
}, {
    _id: 'd2', name: 'Fija', price: 300, allowChanges: false,
    products: [{ productId: { _id: 'a1', title: '1kg de Jitomate $28', price: 28 }, cantidad: 1, unidad: 'kg' }],
}];

const snap = T.construirSnapshot({ productos, despensas });
const codigo = (titulo) => Object.entries(snap.productos).find(([, p]) => p.title.includes(titulo))[0];
const precios = { a1: 28, a2: 160, a3: 68, a4: 20 };
const cliente = {
    nombre: 'Ana Prueba', telefono: '5550000001', direccion: 'Calle 1, Centro',
    costoEnvio: 40, gratisJueves: true,
    misDirecciones: [{ alias: 'Trabajo', direccion: 'Oficina 2', costoEnvio: 60, gratisJueves: false }],
};
const fechasValidas = ['jueves, 15 Octubre 2026', 'viernes, 16 Octubre 2026'];
const ctx = { snap, preciosActuales: precios, cliente, fechasValidas };

test('snapshot: solo productos visibles y en stock', () => {
    const titulos = Object.values(snap.productos).map((p) => p.title);
    assert.ok(!titulos.includes('Producto oculto'));
    assert.ok(!titulos.includes('Producto agotado'));
    assert.strictEqual(titulos.length, 4);
});

test('despensa sin cambios cuesta su precio base', () => {
    const r = T.cotizar({ despensas: [{ nombre: 'familiar' }], fecha: 'viernes, 16 Octubre 2026' }, ctx);
    assert.strictEqual(r.subtotal, 285);
    assert.strictEqual(r.documentos[0].despensa, 'Familiar');
    assert.strictEqual(r.documentos[0].fuente, 'telegram');
});

test('un cambio a un producto más caro sube el total por la diferencia', () => {
    // quita Jitomate ($28), pone Pechuga ($160): +132
    const r = T.cotizar({
        despensas: [{ nombre: 'Familiar', cambios: [{ quitar: 'D1', poner: codigo('pechuga') }] }],
        fecha: 'viernes, 16 Octubre 2026',
    }, ctx);
    assert.strictEqual(r.subtotal, 285 + 132);
    assert.strictEqual(r.documentos[0].deletedProducts[0].nombre, '1kg de Jitomate $28');
    assert.strictEqual(r.documentos[0].newProducts[0].title, '1 Kg pechuga aplanada $160');
});

test('un cambio que baja el total por debajo del precio base se rechaza', () => {
    // quita Aguacate ($68), pone Limón ($20): queda $48 por debajo
    assert.throws(() => T.cotizar({
        despensas: [{ nombre: 'Familiar', cambios: [{ quitar: 'D2', poner: codigo('Limón') }] }],
        fecha: 'viernes, 16 Octubre 2026',
    }, ctx), /por debajo de su precio/);
});

test('ese mismo cambio se acepta si se completa con extras', () => {
    const r = T.cotizar({
        despensas: [{
            nombre: 'Familiar',
            cambios: [{ quitar: 'D2', poner: codigo('Limón') }],
            extras: [{ codigo: codigo('Jitomate'), cantidad: 2 }],   // +56 cubre los 48
        }],
        fecha: 'viernes, 16 Octubre 2026',
    }, ctx);
    assert.strictEqual(r.subtotal, 285 - 48 + 56);
});

test('más de 3 cambios se rechaza', () => {
    const c = codigo('pechuga');
    assert.throws(() => T.cotizar({
        despensas: [{ nombre: 'Familiar', cambios: [
            { quitar: 'D1', poner: c }, { quitar: 'D2', poner: c }, { quitar: 'D3', poner: c }, { quitar: 'D1', poner: c },
        ] }],
        fecha: 'viernes, 16 Octubre 2026',
    }, ctx), /Máximo 3 cambios/);
});

test('una despensa que no admite cambios los rechaza', () => {
    assert.throws(() => T.cotizar({
        despensas: [{ nombre: 'Fija', cambios: [{ quitar: 'D1', poner: codigo('pechuga') }] }],
        fecha: 'viernes, 16 Octubre 2026',
    }, ctx), /no admite cambios/);
});

test('pedido personalizado por debajo de $320 se rechaza', () => {
    assert.throws(() => T.cotizar({
        productos: [{ codigo: codigo('pechuga'), cantidad: 1 }],   // $160
        fecha: 'viernes, 16 Octubre 2026',
    }, ctx), /mínimo de \$320/);
});

test('pedido personalizado de $320 o más pasa, en un documento "Pedido"', () => {
    const r = T.cotizar({
        productos: [{ codigo: codigo('pechuga'), cantidad: 2 }],   // $320
        fecha: 'viernes, 16 Octubre 2026',
    }, ctx);
    assert.strictEqual(r.subtotal, 320);
    assert.strictEqual(r.documentos[0].despensa, 'Pedido');
    assert.strictEqual(r.documentos[0].newProducts.length, 2, 'una entrada por unidad, como la tienda');
});

test('productos sueltos junto a una despensa no tienen mínimo', () => {
    const r = T.cotizar({
        despensas: [{ nombre: 'Familiar' }],
        productos: [{ codigo: codigo('Limón'), cantidad: 1 }],
        fecha: 'viernes, 16 Octubre 2026',
    }, ctx);
    assert.strictEqual(r.documentos.length, 2);
    assert.strictEqual(r.subtotal, 305);
});

test('envío: gratis en jueves en zona azul, cobrado otro día, y una sola vez', () => {
    const jueves = T.cotizar({ despensas: [{ nombre: 'Familiar', cantidad: 2 }], fecha: 'jueves, 15 Octubre 2026' }, ctx);
    assert.strictEqual(jueves.envio, 0);

    const viernes = T.cotizar({ despensas: [{ nombre: 'Familiar', cantidad: 2 }], fecha: 'viernes, 16 Octubre 2026' }, ctx);
    assert.strictEqual(viernes.envio, 40);
    assert.strictEqual(viernes.documentos[0].envio, 40);
    assert.strictEqual(viernes.documentos[1].envio, 0, 'el envío solo en el primer documento');
    assert.strictEqual(viernes.total, 285 * 2 + 40);
});

test('dirección secundaria usa su propio costo de envío', () => {
    const r = T.cotizar({ despensas: [{ nombre: 'Familiar' }], fecha: 'jueves, 15 Octubre 2026', direccion: 1 }, ctx);
    assert.strictEqual(r.envio, 60, 'la oficina no es zona azul: paga aunque sea jueves');
    assert.strictEqual(r.direccion, 'Oficina 2');
});

test('la promo se reclama solo en el primer documento', () => {
    const r = T.cotizar({ despensas: [{ nombre: 'Familiar', cantidad: 3 }], fecha: 'viernes, 16 Octubre 2026' }, ctx);
    assert.deepStrictEqual(r.documentos.map((d) => d.aplicarPromo), [true, false, false]);
});

test('el precio sale de la base, no del snapshot: si cambió, se usa el nuevo y se avisa', () => {
    const r = T.cotizar({
        productos: [{ codigo: codigo('pechuga'), cantidad: 2 }],
        fecha: 'viernes, 16 Octubre 2026',
    }, { ...ctx, preciosActuales: { ...precios, a2: 175 } });
    assert.strictEqual(r.subtotal, 350);
    assert.match(r.avisos[0], /cambió a \$175/);
});

test('un producto que se agotó después del snapshot se rechaza', () => {
    const { a2, ...sinPechuga } = precios;
    assert.throws(() => T.cotizar({
        productos: [{ codigo: codigo('pechuga'), cantidad: 2 }],
        fecha: 'viernes, 16 Octubre 2026',
    }, { ...ctx, preciosActuales: sinPechuga }), /ya no está disponible/);
});

test('códigos inventados y fechas fuera de la lista se rechazan', () => {
    assert.throws(() => T.cotizar({ productos: [{ codigo: 'P999', cantidad: 1 }], fecha: 'viernes, 16 Octubre 2026' }, ctx), /No existe el producto/);
    assert.throws(() => T.cotizar({ despensas: [{ nombre: 'Familiar' }], fecha: 'lunes, 19 Octubre 2026' }, ctx), /La fecha debe ser una de/);
    assert.throws(() => T.cotizar({ despensas: [{ nombre: 'Inventada' }], fecha: 'viernes, 16 Octubre 2026' }, ctx), /No existe la despensa/);
});

test('cantidades absurdas se rechazan', () => {
    assert.throws(() => T.cotizar({ productos: [{ codigo: codigo('pechuga'), cantidad: 500 }], fecha: 'viernes, 16 Octubre 2026' }, ctx), /entre 1 y 50/);
    assert.throws(() => T.cotizar({ productos: [{ codigo: codigo('pechuga'), cantidad: -2 }], fecha: 'viernes, 16 Octubre 2026' }, ctx), /entre 1 y 50/);
});

test('fechas: sin domingo, sin hoy, y después de las 8 PM sin mañana', () => {
    const cfg = ['miércoles, 14 Octubre 2026', 'jueves, 15 Octubre 2026', 'viernes, 16 Octubre 2026', 'domingo, 18 Octubre 2026'];
    // miércoles 14 a las 7 PM en Pachuca (= 01:00 UTC del 15)
    const antes = T.fechasDisponibles(cfg, new Date('2026-10-15T01:00:00Z'));
    assert.deepStrictEqual(antes, ['jueves, 15 Octubre 2026', 'viernes, 16 Octubre 2026']);
    // miércoles 14 a las 8:30 PM en Pachuca (= 02:30 UTC del 15)
    const despues = T.fechasDisponibles(cfg, new Date('2026-10-15T02:30:00Z'));
    assert.deepStrictEqual(despues, ['viernes, 16 Octubre 2026']);
});

test('la despensa se encuentra aunque la escriban como "Despensa Familiar" o "la familiar"', () => {
    for (const n of ['Familiar', 'familiar', 'Despensa Familiar', 'la familiar', '  DESPENSA familiar ']) {
        assert.ok(T.buscarDespensa(snap, n), `no encontró "${n}"`);
        const r = T.cotizar({ despensas: [{ nombre: n }], fecha: 'viernes, 16 Octubre 2026' }, ctx);
        assert.strictEqual(r.subtotal, 285);
    }
});

test('fotos: piden una despensa con prefijo y la encuentra', () => {
    const conFoto = T.construirSnapshot({
        productos,
        despensas: despensas.map((d) => ({ ...d, img: 'https://ejemplo/' + d.name + '.jpg' })),
    });
    const f = T.fotosPara(conFoto, { despensas: ['Despensa Familiar'] });
    assert.strictEqual(f.length, 1);
    assert.match(f[0].pie, /Familiar/);
});

// --- Cierre semanal: viernes 7 PM -> lunes 11 AM (hora de Pachuca = UTC-6) ---
const mx = (iso) => new Date(iso); // escritas en UTC; restar 6 h para leerlas en Pachuca

test('cierre: abierto el viernes a las 6:59 PM, cerrado a las 7:00 PM', () => {
    assert.strictEqual(T.pedidosCerrados(mx('2026-10-17T00:59:00Z')), false); // vie 16, 18:59
    assert.strictEqual(T.pedidosCerrados(mx('2026-10-17T01:00:00Z')), true);  // vie 16, 19:00
});

test('cierre: todo el sábado y el domingo cerrado', () => {
    assert.strictEqual(T.pedidosCerrados(mx('2026-10-17T18:00:00Z')), true);  // sáb 12:00
    assert.strictEqual(T.pedidosCerrados(mx('2026-10-19T05:00:00Z')), true);  // dom 23:00
});

test('cierre: el lunes cerrado hasta las 11 AM', () => {
    assert.strictEqual(T.pedidosCerrados(mx('2026-10-19T16:59:00Z')), true);  // lun 10:59
    assert.strictEqual(T.pedidosCerrados(mx('2026-10-19T17:00:00Z')), false); // lun 11:00
    assert.strictEqual(T.pedidosCerrados(mx('2026-10-21T18:00:00Z')), false); // mié 12:00
});

test('cierre: si el admin marca las despensas listas, abre antes', () => {
    const domingo = mx('2026-10-18T20:00:00Z');                 // dom 14:00
    assert.strictEqual(T.pedidosCerrados(domingo, mx('2026-10-18T19:00:00Z')), false); // marcadas dom 13:00
    // una marca de la semana pasada no abre este cierre
    assert.strictEqual(T.pedidosCerrados(domingo, mx('2026-10-12T17:00:00Z')), true);
});

test('próximo cierre: el viernes de esa semana a las 7 PM', () => {
    // subida el jueves 15 -> vence el viernes 16 a las 19:00 MX (= sáb 17 01:00 UTC)
    assert.strictEqual(T.proximoCierre(mx('2026-10-15T17:00:00Z')).toISOString(), '2026-10-17T01:00:00.000Z');
    // subida el domingo 18 (cerrado) -> vale para la semana siguiente: vie 23
    assert.strictEqual(T.proximoCierre(mx('2026-10-18T20:00:00Z')).toISOString(), '2026-10-24T01:00:00.000Z');
});

// --- Alta de clientes nuevos (utils/telegramRegistro.js) ---
const reg = require('../utils/telegramRegistro');
test('registro: limpia y valida el nombre', () => {
    assert.equal(reg.limpiarNombre('  juan   pérez '), 'Juan Pérez');
    assert.equal(reg.limpiarNombre('12'), null);
    assert.equal(reg.limpiarNombre('7711234567'), null);
});
test('registro: reconoce links de Google Maps', () => {
    assert.equal(reg.linkMapsEnTexto('aquí https://maps.app.goo.gl/AbC123 gracias'), 'https://maps.app.goo.gl/AbC123');
    assert.ok(reg.linkMapsEnTexto('https://www.google.com/maps/place/Pachuca'));
    assert.equal(reg.linkMapsEnTexto('https://ejemplo.com/maps'), null);
    assert.equal(reg.linkMaps(20.1, -98.7), 'https://www.google.com/maps?q=20.100000,-98.700000');
});

// --- Pueblos con punto de entrega ---
test('pueblos: solo viernes, sin envío y con el punto en la nota', () => {
    const tiza = { ...cliente, nombre: 'Ana - Tizayuca', direccion: 'Calle 5, Tizayuca', costoEnvio: 60, gratisJueves: false };
    const c2 = { ...ctx, cliente: tiza };
    assert.throws(() => T.cotizar({ despensas: [{ nombre: 'familiar' }], fecha: 'jueves, 15 Octubre 2026' }, c2),
        /solo entregamos el viernes/);
    const r = T.cotizar({ despensas: [{ nombre: 'familiar' }], fecha: 'viernes, 16 Octubre 2026' }, c2);
    assert.equal(r.envio, 0);
    assert.match(r.documentos[0].nota, /ENTREGA EN PUNTO/);
    assert.match(r.resumen, /Tizayuca/);
});
test('pueblos: Acayuca gana a Zapotlán', () => {
    assert.equal(T.puebloDe('Acayuca, Zapotlán de Juárez').clave, 'acayuca');
    assert.equal(T.puebloDe('Centro, Pachuca'), null);
});

// --- Regalos por despensas ---
const REGALOS = [
    { nombre: '300g de papas', unidad: 'g', tier: 1 }, { nombre: '1.5 kg de Naranja', unidad: 'g', tier: 1 },
    { nombre: '1kg de Manzana Amarilla ', unidad: 'pieza', tier: 2 }, { nombre: '2.5 kg de Naranja', unidad: 'kg', tier: 2 },
    { nombre: 'DESCUENTO $50 PESOS', unidad: 'descuento', tier: 1 },
];
test('regalos: 2 normales → nivel 1; 2 premium/parrillera → nivel 2; 4+ → 2 o descuento', () => {
    assert.deepEqual(T.regalosPorDespensas(['Familiar'], REGALOS).cantidad, 0);
    const a = T.regalosPorDespensas(['Familiar', 'Premium'], REGALOS);
    assert.equal(a.cantidad, 1); assert.deepEqual(a.opciones, ['300g de papas', '1.5 kg de Naranja']);
    const b = T.regalosPorDespensas(['Premium', 'Parrillera'], REGALOS);
    assert.deepEqual(b.opciones, ['1kg de Manzana Amarilla', '2.5 kg de Naranja']);
    const c = T.regalosPorDespensas(['Familiar', 'Familiar', 'Jumbo', 'Especial'], REGALOS);
    assert.equal(c.cantidad, 2); assert.ok(c.opciones.includes('DESCUENTO $50 PESOS'));
});

// --- Productos de peso variable (precio $0 + "PENDIENTE PRECIO") ---
test('precio por confirmar: se vende, no suma al total y queda en la nota', () => {
    const snap2 = T.construirSnapshot({
        productos: [...productos, { _id: 'pap', title: '1 Papaya $34 kg PENDIENTE PRECIO', price: 0, categories: ['Frutas'] }],
        despensas,
    });
    const [codigo, pap] = Object.entries(snap2.productos).find(([, p]) => p.id === 'pap');
    assert.equal(pap.title, '1 Papaya');
    assert.equal(pap.referencia, '$34 el kg');
    assert.match(T.textoCatalogo(snap2), /1 Papaya — precio según su peso \(aprox\. \$34 el kg\)/);
    const r = T.cotizar({ despensas: [{ nombre: 'familiar' }], productos: [{ codigo, cantidad: 1 }], fecha: 'viernes, 16 Octubre 2026' },
        { ...ctx, snap: snap2, preciosActuales: { ...precios, pap: 0 } });
    const sin = T.cotizar({ despensas: [{ nombre: 'familiar' }], fecha: 'viernes, 16 Octubre 2026' }, ctx);
    assert.equal(r.total, sin.total);
    assert.match(r.resumen, /1 Papaya — precio según su peso/);
    assert.match(r.documentos[r.documentos.length - 1].nota, /PRECIO POR CONFIRMAR \(pesar\): 1 Papaya/);
});
