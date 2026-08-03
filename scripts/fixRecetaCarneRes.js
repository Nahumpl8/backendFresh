/**
 * Corrige la receta cacheada (componentes) del combo mal descompuesto por la IA:
 *   "PROMO de 1kg carne de res en trozo"
 *   ANTES:  1kg "Maciza de cerdo en trozo" [Amezcua]   <- alucinación (res -> cerdo)
 *   DESPUÉS:1kg "Carne de res en trozo"     [Amezcua]
 *
 * "Carne de res en trozo" no existe como producto suelto en el catálogo; para la lista de
 * compras basta el nombre literal + su proveedor (Amezcua, familia de res).
 *
 *   node scripts/fixRecetaCarneRes.js          -> DRY-RUN (reporta, respalda, no escribe)
 *   APPLY=1 node scripts/fixRecetaCarneRes.js   -> aplica (respalda primero)
 */
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const Product = require('../models/Product');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DRY_RUN = process.env.APPLY !== '1';
const TITULO = 'PROMO de 1kg carne de res en trozo $144';
const NUEVA_RECETA = [
    { nombre: 'Carne de res en trozo', cantidad: 1, unidad: 'kg', proveedor: 'Amezcua' },
];

(async () => {
    await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 8000 });

    const p = await Product.findOne({ title: TITULO });
    if (!p) {
        console.error(`No se encontró el producto: ${TITULO}`);
        await mongoose.disconnect();
        process.exit(1);
    }

    console.log(`Producto: ${p.title}`);
    console.log(`Receta ACTUAL:  ${JSON.stringify(p.componentes)}`);
    console.log(`Receta NUEVA:   ${JSON.stringify(NUEVA_RECETA)}`);

    // Respaldo del estado anterior
    const backupDir = path.resolve(__dirname, '../backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `receta_carneRes_backup_${p._id}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({ _id: p._id, title: p.title, componentes: p.componentes }, null, 2));
    console.log(`\nRespaldo guardado en: ${backupPath}`);

    if (DRY_RUN) {
        console.log('\n(DRY-RUN) No se escribió nada. Corre con APPLY=1 para aplicar.');
    } else {
        await Product.updateOne({ _id: p._id }, { $set: { componentes: NUEVA_RECETA } });
        console.log('\n✅ Receta corregida.');
    }

    await mongoose.disconnect();
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
