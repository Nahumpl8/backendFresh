/** Pruebas de la agrupación del PDF de productos. Sin red ni base de datos. */
const test = require('node:test');
const assert = require('node:assert');
const L = require('../utils/listaPdf');

const P = (o) => ({ showInWeb: true, inStock: true, categories: ['Carne de Res 🥩'], img: 'https://i.ibb.co/x.jpg', ...o });

test('presentación a partir del título', () => {
    assert.strictEqual(L.presentacion('500g de Maciza de cerdo $52'), '500gr');
    assert.strictEqual(L.presentacion('1Kg de Top Sirloin $236'), '1 kg');
    assert.strictEqual(L.presentacion('5 pza de Nopales'), '5 pza.');
    assert.strictEqual(L.presentacion('1 Media pechuga aplanada $55'), null);
});

test('junta presentaciones del mismo producto y las ordena por precio', () => {
    const [s] = L.agrupar([
        P({ title: '1Kg de Top Sirloin $236', nombreSinUnidades: 'Top Sirloin', price: 236 }),
        P({ title: '500g de Top Sirloin $118', nombreSinUnidades: 'Top Sirloin', price: 118 }),
    ]);
    assert.strictEqual(s.tarjetas.length, 1);
    assert.deepStrictEqual(s.tarjetas[0].presentaciones.map((p) => p.etiqueta), ['500gr', '1 kg']);
});

test('"Bisteces de res" y "Bisteces Res" son la misma tarjeta', () => {
    const [s] = L.agrupar([
        P({ title: '500g de Bisteces de res $94', nombreSinUnidades: 'Bisteces de res', price: 94 }),
        P({ title: '1kg de Bisteces res $188', nombreSinUnidades: 'Bisteces Res', price: 188 }),
    ]);
    assert.strictEqual(s.tarjetas.length, 1);
    assert.strictEqual(s.tarjetas[0].presentaciones.length, 2);
});

test('ignora fotos blob:, "test" o vacías y usa la buena del grupo', () => {
    const [s] = L.agrupar([
        P({ title: '500g de Chambarete $90', nombreSinUnidades: 'Chambarete', price: 90, img: 'blob:https://x/abc' }),
        P({ title: '1kg de Chambarete $180', nombreSinUnidades: 'Chambarete', price: 180, img: 'https://i.ibb.co/ok.jpg' }),
    ]);
    assert.strictEqual(s.tarjetas[0].img, 'https://i.ibb.co/ok.jpg');
    const [s2] = L.agrupar([P({ title: '500g de X $10', nombreSinUnidades: 'X', price: 10, img: 'test' })]);
    assert.strictEqual(s2.tarjetas[0].img, null);
});

test('las promociones conservan la cantidad en el nombre', () => {
    const [s] = L.agrupar([P({
        title: 'PROMO de 2kg de limon $40', nombreSinUnidades: 'Limon', price: 40, categories: ['Promociones 🎫'],
    })]);
    assert.strictEqual(s.titulo, 'PROMOCIONES DE LA SEMANA');
    assert.strictEqual(s.tarjetas[0].nombre, '2kg de limon');
});

test('agotados, ocultos y sin precio no salen; secciones en el orden del PDF', () => {
    const secs = L.agrupar([
        P({ title: 'Agotado', nombreSinUnidades: 'Agotado', price: 10, inStock: false }),
        P({ title: 'Oculto', nombreSinUnidades: 'Oculto', price: 10, showInWeb: false }),
        P({ title: 'Gratis', nombreSinUnidades: 'Gratis', price: 0 }),
        P({ title: '1kg de Manzana $65', nombreSinUnidades: 'Manzana', price: 65, categories: ['Frutas 🍎'] }),
        P({ title: '1kg de Arrachera $200', nombreSinUnidades: 'Arrachera', price: 200 }),
    ]);
    assert.deepStrictEqual(secs.map((s) => s.titulo), ['RES', 'FRUTAS']);
});

test('la huella cambia si cambia un precio, y no si no cambia nada', () => {
    const a = [P({ _id: '1', title: 'X', price: 10 })];
    assert.strictEqual(L.huella(a), L.huella([P({ _id: '1', title: 'X', price: 10 })]));
    assert.notStrictEqual(L.huella(a), L.huella([P({ _id: '1', title: 'X', price: 11 })]));
});
