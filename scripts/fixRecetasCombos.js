/**
 * Corrige recetas (componentes) de combos mal decompuestos por la IA + un cupón sin proveedor.
 * La IA alucinó componentes que no tienen relación con el título del combo.
 *
 *   node scripts/fixRecetasCombos.js          -> DRY-RUN (reporta + respalda, no escribe)
 *   APPLY=1 node scripts/fixRecetasCombos.js   -> aplica (respalda primero)
 *
 * Productos verificados en el catálogo (nombreSinUnidades | proveedor).
 */
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const Product = require('../models/Product');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DRY_RUN = process.env.APPLY !== '1';

// Cambios: por título -> { componentes?, proveedor? }
const CAMBIOS = [
    {
        title: 'PROMO de 1 kg uva roja y 1 kg guayaba $54',
        componentes: [
            { nombre: 'Uva roja', cantidad: 1, unidad: 'kg', proveedor: 'Central' },
            { nombre: 'Guayaba', cantidad: 1, unidad: 'kg', proveedor: 'Central' },
        ],
    },
    {
        title: 'PROMO de 1kg pierna y muslo, 250gr mole rojo y 1 kg arroz $100',
        componentes: [
            { nombre: 'Pierna y muslo', cantidad: 1, unidad: 'kg', proveedor: 'Chicken' },
            { nombre: 'Mole rojo almendrado', cantidad: 250, unidad: 'g', proveedor: 'Tucán' },
            { nombre: 'Arroz', cantidad: 1, unidad: 'kg', proveedor: 'Tucán' },
        ],
    },
    {
        // Cupón simple (1 kg uva roja). No es combo real: darle proveedor para que salga como extra normal.
        title: 'Cupón de 1 kg Uva roja $36',
        proveedor: 'Central',
    },
];

(async () => {
    await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 8000 });

    const backupDir = path.resolve(__dirname, '../backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const respaldo = [];
    for (const c of CAMBIOS) {
        const p = await Product.findOne({ title: c.title }).select('title proveedor componentes');
        if (!p) { console.log(`❌ NO ENCONTRADO: ${c.title}`); continue; }
        respaldo.push({ _id: p._id, title: p.title, proveedor: p.proveedor, componentes: p.componentes });

        console.log(`\n• ${p.title}`);
        if (c.componentes) {
            console.log(`   receta ACTUAL:  ${JSON.stringify(p.componentes)}`);
            console.log(`   receta NUEVA:   ${JSON.stringify(c.componentes)}`);
        }
        if (c.proveedor) {
            console.log(`   proveedor ACTUAL: ${JSON.stringify(p.proveedor)} -> NUEVO: ${JSON.stringify(c.proveedor)}`);
        }

        if (!DRY_RUN) {
            const set = {};
            if (c.componentes) set.componentes = c.componentes;
            if (c.proveedor) set.proveedor = c.proveedor;
            await Product.updateOne({ _id: p._id }, { $set: set });
        }
    }

    const backupPath = path.join(backupDir, 'recetasCombos_backup.json');
    fs.writeFileSync(backupPath, JSON.stringify(respaldo, null, 2));
    console.log(`\nRespaldo guardado en: ${backupPath}`);
    console.log(DRY_RUN ? '\n(DRY-RUN) No se escribió nada. Corre con APPLY=1 para aplicar.' : '\n✅ Cambios aplicados.');

    await mongoose.disconnect();
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
