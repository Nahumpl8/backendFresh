/**
 * Corrige el campo minUnit de los productos usando el TÍTULO como fuente de verdad.
 * Convención correcta: peso en KG (0.3 = 300g, 1 = 1kg), piezas = número de piezas.
 * Bug: algunos productos tienen minUnit en gramos (300, 100) en vez de kg (0.3, 0.1).
 *
 *   node scripts/fixMinUnit.js          -> DRY-RUN (solo reporta lo que cambiaría)
 *   APPLY=1 node scripts/fixMinUnit.js   -> aplica
 *
 * Solo toca productos cuyo título trae la cantidad (ej "300gr de Chistorra") y cuyo
 * minUnit guardado difiere del esperado. No inventa nada.
 */
const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');
const Product = require('../models/Product');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DRY_RUN = process.env.APPLY !== '1';

// Devuelve el minUnit esperado (kg para peso, piezas para pza) desde el título, o null.
function esperadoDeTitulo(titulo) {
    const m = String(titulo || '').match(/^\s*(\d+(?:\.\d+)?)\s*(kg|kilos?|gr?|gramos?|pza|pzas|pieza|piezas|pz|penca)/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!(n > 0)) return null;
    const u = m[2].toLowerCase();
    if (/^p/.test(u)) return { minUnit: n, tipo: 'pza' };
    if (u === 'kg' || u.startsWith('kilo')) return { minUnit: n, tipo: 'peso(kg)' };
    return { minUnit: n / 1000, tipo: 'peso(g)' }; // g/gr/gramos -> kg
}

const ejecutar = async () => {
    await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 8000 });
    const prods = await Product.find({}).select('title minUnit unit');
    const cambios = [];
    for (const p of prods) {
        const esp = esperadoDeTitulo(p.title);
        if (!esp) continue;
        const actual = Number(p.minUnit);
        // diferencia relativa > 5% => corregir
        if (!(Math.abs(actual - esp.minUnit) > Math.max(0.001, esp.minUnit * 0.05))) continue;
        cambios.push({ id: p._id, title: p.title, de: actual, a: esp.minUnit, tipo: esp.tipo });
    }

    console.log(`\nProductos: ${prods.length} | a corregir: ${cambios.length}${DRY_RUN ? ' (DRY-RUN)' : ' (APLICANDO)'}\n`);
    cambios.sort((a, b) => (b.de / (b.a || 1)) - (a.de / (a.a || 1)));
    cambios.forEach(c => console.log(`  ${String(c.de).padStart(6)} -> ${String(c.a).padEnd(7)} [${c.tipo}]  ${c.title}`));

    if (!DRY_RUN) {
        for (const c of cambios) await Product.updateOne({ _id: c.id }, { $set: { minUnit: c.a } });
        console.log(`\n✅ Aplicados ${cambios.length} cambios.`);
    }
    await mongoose.disconnect();
    process.exit(0);
};

ejecutar().catch(err => { console.error(err); process.exit(1); });
