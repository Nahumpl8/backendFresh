/**
 * Backfill del campo `proveedor` en los productos existentes.
 *
 * Uso:
 *   node scripts/asignarProveedores.js          -> DRY-RUN (no escribe, solo reporta)
 *   APPLY=1 node scripts/asignarProveedores.js  -> aplica los cambios
 *   FORCE=1 ...                                  -> sobreescribe proveedor ya asignado
 *
 * Reglas del negocio (proveedores):
 *  - Central: todas las frutas y verduras
 *  - Tucán: abarrotes, semillas, chiles secos
 *  - Pescados y Mariscos: pescado y mariscos
 *  - Amezcua: cortes de res (default de la categoría) + arrachera/milanesa/maciza/pastor de cerdo
 *  - La Mexicana: chistorra, chamorro, chuleta, chorizo argentino, costilla de cerdo, molida de cerdo, carne enchilada
 *  - Carne Mart: congelados/empanizados (nugget, boneless, tiras/milanesa de pollo, papas, tocino,
 *                medallones, baby back, salchicha pavo económica, alitas, queso manchego/parmesano)
 *  - Cremería San Antonio: lácteos, cremas, leches, quesos varios, jamones/salchichas San Rafael/FUD,
 *                          queso puerco, longaniza, chorizo huasteco, botanero
 *  - Azpeitia: jamón económico, queso canasto
 *  - Pollo Santa Julia: pechugas, molida de pollo, pollo entero
 *  - Chicken: pierna y muslo
 *  - Huevo Portales: huevo
 *  - Mole: mole rojo/verde
 *
 * Las "Promociones 🎫" (combos) se dejan SIN proveedor a propósito: se descomponen en la Fase 3.
 */

const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');
const Product = require('../models/Product');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DRY_RUN = process.env.APPLY !== '1';
const FORCE = process.env.FORCE === '1';

const norm = (s) => (s || '')
    .toString()
    .split('$')[0]
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

// Categoría exacta -> proveedor (determinista)
const CATEGORIA_PROVEEDOR = {
    'Frutas 🍎': 'Central',
    'Verduras 🥕': 'Central',
    'Abarrotes y semillas 🥫': 'Tucán',
    'Pescados y mariscos 🐟': 'Pescados y Mariscos',
};

// Reglas por palabra clave (ORDEN IMPORTA: la primera que coincide gana)
const KEYWORD_RULES = [
    // --- Huevo ---
    ['huevo', 'Huevo Portales'],

    // --- Azpeitia (antes que los quesos/jamones genéricos) ---
    ['queso canasto', 'Azpeitia'],
    ['jamon economico', 'Azpeitia'],

    // --- Cremería San Antonio: embutidos específicos (antes que genéricos) ---
    ['jamon de pierna san rafael', 'Cremería San Antonio'],
    ['jamon pavo fud', 'Cremería San Antonio'],
    ['jamon de pavo', 'Cremería San Antonio'],
    ['queso puerco', 'Cremería San Antonio'],
    ['salchicha pavo san rafael', 'Cremería San Antonio'],
    ['salchicha pavo economica', 'Carne Mart'],
    ['salchica fud', 'Cremería San Antonio'],
    ['fud', 'Cremería San Antonio'],
    ['san rafael', 'Cremería San Antonio'],
    ['longaniza', 'Cremería San Antonio'],
    ['chorizo huasteco', 'Cremería San Antonio'],
    ['queso manchego botanero', 'Cremería San Antonio'],
    ['botanero', 'Cremería San Antonio'],

    // --- Carne Mart: congelados / empanizados ---
    ['queso manchego', 'Carne Mart'],
    ['manchego', 'Carne Mart'],
    ['parmesano', 'Carne Mart'],
    ['nugget', 'Carne Mart'],
    ['papas a la francesa', 'Carne Mart'],
    ['papa a la francesa', 'Carne Mart'],
    ['tocino', 'Carne Mart'],
    ['medallones', 'Carne Mart'],
    ['tiras de pollo', 'Carne Mart'],
    ['boneless', 'Carne Mart'],
    ['milanesa de pollo', 'Carne Mart'],
    ['alitas', 'Carne Mart'],
    ['baby back', 'Carne Mart'],
    ['babi back', 'Carne Mart'],
    ['pavo ahumado', 'Carne Mart'],
    ['pavo natural', 'Carne Mart'],

    // --- La Mexicana: cerdo / embutidos ---
    ['chistorra', 'La Mexicana'],
    ['chamorro', 'La Mexicana'],
    ['chuleta', 'La Mexicana'],
    ['chorizo argentino', 'La Mexicana'],
    ['costilla de cerdo', 'La Mexicana'],
    ['molida de cerdo', 'La Mexicana'],
    ['carne enchilada', 'La Mexicana'],
    ['lomo de cerdo', 'La Mexicana'],
    ['chicharron', 'La Mexicana'],
    ['manita de cerdo', 'La Mexicana'],
    ['pierna de cerdo', 'La Mexicana'],

    // --- Amezcua: res + cerdo específico ---
    ['arrachera', 'Amezcua'],
    ['ribeye', 'Amezcua'],
    ['picana', 'Amezcua'],
    ['new york', 'Amezcua'],
    ['bistec', 'Amezcua'],
    ['chambarete', 'Amezcua'],
    ['aguja de res', 'Amezcua'],
    ['molida de res', 'Amezcua'],
    ['alambre de res', 'Amezcua'],
    ['maciza de cerdo', 'Amezcua'],
    ['milanesa de cerdo', 'Amezcua'],
    ['pastor', 'Amezcua'],
    ['carne de res en trozo', 'Amezcua'],

    // --- Pollo Santa Julia ---
    ['pechuga', 'Pollo Santa Julia'],
    ['molida de pollo', 'Pollo Santa Julia'],
    ['pollo entero', 'Pollo Santa Julia'],

    // --- Chicken: pierna y muslo (muslo solo existe en pollo) ---
    ['pierna y muslo', 'Chicken'],
    ['muslo', 'Chicken'],

    // --- Mole ---
    ['mole rojo', 'Mole'],
    ['mole verde', 'Mole'],
];

// Default por categoría cuando ninguna keyword aplicó
const CATEGORIA_DEFAULT = {
    'Carne de Res 🥩': 'Amezcua',
    'Lacteos y huevo 🥚': 'Cremería San Antonio',
};

// Categorías que se dejan SIN proveedor (combos → Fase 3)
const CATEGORIAS_SKIP = ['Promociones 🎫'];

const asignar = (producto) => {
    const cat = producto.categories && producto.categories[0];
    if (CATEGORIAS_SKIP.includes(cat)) return null;

    // 1) Categoría determinista
    if (CATEGORIA_PROVEEDOR[cat]) return CATEGORIA_PROVEEDOR[cat];

    // 2) Palabra clave
    const nombre = norm(producto.nombreSinUnidades || producto.title);
    for (const [kw, prov] of KEYWORD_RULES) {
        if (nombre.includes(kw)) return prov;
    }

    // 3) Default por categoría
    if (CATEGORIA_DEFAULT[cat]) return CATEGORIA_DEFAULT[cat];

    return null; // sin asignar → revisar/manual
};

const ejecutar = async () => {
    const uri = process.env.MONGO_URL || process.env.DB_URI;
    if (!uri) { console.error('Falta MONGO_URL en .env'); process.exit(1); }
    await mongoose.connect(uri);

    const productos = await Product.find({});
    const conteo = {};
    const sinAsignar = [];
    let aActualizar = 0;

    for (const p of productos) {
        const prov = asignar(p);
        if (!prov) {
            const cat = (p.categories && p.categories[0]) || 'SIN_CAT';
            if (!CATEGORIAS_SKIP.includes(cat)) {
                sinAsignar.push(`[${cat}] ${(p.nombreSinUnidades || p.title || '').split('$')[0].trim()}`);
            }
            continue;
        }
        conteo[prov] = (conteo[prov] || 0) + 1;

        if (!FORCE && p.proveedor) continue; // no sobreescribir
        aActualizar++;
        if (!DRY_RUN) {
            await Product.updateOne({ _id: p._id }, { $set: { proveedor: prov } });
        }
    }

    console.log('\n===== RESUMEN por proveedor =====');
    Object.entries(conteo).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${v.toString().padStart(3)}  ${k}`));
    console.log(`\nTotal productos: ${productos.length}`);
    console.log(`Promociones (skip): ${productos.filter(p => CATEGORIAS_SKIP.includes(p.categories && p.categories[0])).length}`);
    console.log(`A actualizar: ${aActualizar}${DRY_RUN ? ' (DRY-RUN, no escrito)' : ' (APLICADO)'}`);

    console.log(`\n===== SIN ASIGNAR (${sinAsignar.length}) — revisar/manual =====`);
    sinAsignar.sort().forEach(t => console.log('  ' + t));

    await mongoose.disconnect();
    process.exit(0);
};

ejecutar().catch(err => { console.error(err); process.exit(1); });
