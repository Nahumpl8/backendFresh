/**
 * Re-deriva `nombreSinUnidades` SOLO para la familia de líquidos/caja (leche, crema, yogurt),
 * cuyo valor quedó mal capturado y nunca se re-derivó (ej. "1 caja de 6lt Leche Santa Clara
 * ENTERA" tenía nsu "Leche Santa Clara DESLACTOSADA"; cremas con ". de ..."). Usa la función
 * canónica extractNameFromTitle (ya mejorada para "caja de N lt" y "Pza."). Filtra por título
 * para NO tocar los ~110 nombres curados de otras familias.
 *
 *   node scripts/fixNsuLiquidos.js                              -> DRY-RUN (reporta + respalda)
 *   APPLY=1 node scripts/fixNsuLiquidos.js                      -> aplica
 *   MONGO_URL="..." [APPLY=1] node scripts/fixNsuLiquidos.js    -> con URL explícita (no está en .env local)
 */
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const Product = require('../models/Product');
const { extractNameFromTitle } = require('../utils/extractName');

dotenv.config({ path: path.resolve(__dirname, '../.env') });
const DRY_RUN = process.env.APPLY !== '1';
const MONGO_URL = process.env.MONGO_URL;

// Solo productos líquidos/caja: leche, crema, yogurt, "caja de N", o "N lt/Lt" en el título.
const FAMILIA = /leche|crema|yogur|caja\s+de\s+\d|\d\s*l?t\b/i;

(async () => {
    if (!MONGO_URL) { console.error('❌ Falta MONGO_URL (no está en el .env local; pásala como env var).'); process.exit(1); }
    await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: 8000 });

    const backupDir = path.resolve(__dirname, '../backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const prods = await Product.find({}).select('title nombreSinUnidades');
    const respaldo = [];
    let cambiados = 0;

    for (const p of prods) {
        const title = p.title || '';
        if (!FAMILIA.test(title)) continue;
        const nuevo = extractNameFromTitle(title);
        if (!nuevo || nuevo === p.nombreSinUnidades) continue;
        respaldo.push({ _id: p._id, title: p.title, nombreSinUnidades: p.nombreSinUnidades });
        console.log(`• ${p.title}\n   ${JSON.stringify(p.nombreSinUnidades)} -> ${JSON.stringify(nuevo)}`);
        cambiados++;
        if (!DRY_RUN) await Product.updateOne({ _id: p._id }, { $set: { nombreSinUnidades: nuevo } });
    }

    if (respaldo.length) {
        fs.writeFileSync(path.join(backupDir, 'nsuLiquidos_backup.json'), JSON.stringify(respaldo, null, 2));
        console.log(`\nRespaldo: backups/nsuLiquidos_backup.json (${respaldo.length} productos)`);
    }
    console.log(`\n${cambiados} producto(s) ${DRY_RUN ? 'a cambiar' : 'actualizados'}.`);
    console.log(DRY_RUN ? '(DRY-RUN) Corre con APPLY=1 para aplicar.' : '✅ Aplicado.');
    await mongoose.disconnect();
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
