/**
 * Corrige productos cuyo `nombreSinUnidades` quedó mal capturado (no corresponde a su título).
 * Ese campo es el que usa el INVENTARIO para nombrar/agrupar, así que un valor equivocado hace
 * que un producto aparezca en la lista con OTRO nombre (ej. Milanesa de pollo -> "Pierna de cerdo
 * sin hueso"). Detectado por auditoría el 5 Ago 2026.
 *
 *   node scripts/fixNombreSinUnidades.js          -> DRY-RUN (reporta + respalda)
 *   APPLY=1 node scripts/fixNombreSinUnidades.js   -> aplica
 *
 * Mapeos explícitos (verificados). No se tocan los productos basura ("0", "BORRA 45").
 */
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const Product = require('../models/Product');

dotenv.config({ path: path.resolve(__dirname, '../.env') });
const DRY_RUN = process.env.APPLY !== '1';

const CAMBIOS = [
    { title: '500gr de Milanesa de pollo empanizada $64', nombreSinUnidades: 'Milanesa de pollo empanizada' },
    { title: '500gr de Camarón fresco chico $105', nombreSinUnidades: 'Camarón fresco chico' },
    { title: '500gr de Camarón fresco grande $120', nombreSinUnidades: 'Camarón fresco grande' },
    { title: '500gr Cecina de res $120', nombreSinUnidades: 'Cecina de res' },
    { title: '1 Kg de Huevo ORGANICO ♻️ $60', nombreSinUnidades: 'Huevo ORGANICO ♻️' },
];

(async () => {
    await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 8000 });
    const backupDir = path.resolve(__dirname, '../backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const respaldo = [];
    for (const c of CAMBIOS) {
        const p = await Product.findOne({ title: c.title }).select('title nombreSinUnidades');
        if (!p) { console.log(`❌ NO ENCONTRADO: ${c.title}`); continue; }
        respaldo.push({ _id: p._id, title: p.title, nombreSinUnidades: p.nombreSinUnidades });
        console.log(`• ${p.title}\n   nombreSinUnidades: ${JSON.stringify(p.nombreSinUnidades)} -> ${JSON.stringify(c.nombreSinUnidades)}`);
        if (!DRY_RUN) await Product.updateOne({ _id: p._id }, { $set: { nombreSinUnidades: c.nombreSinUnidades } });
    }

    fs.writeFileSync(path.join(backupDir, 'nombreSinUnidades_backup.json'), JSON.stringify(respaldo, null, 2));
    console.log(`\nRespaldo: backups/nombreSinUnidades_backup.json`);
    console.log(DRY_RUN ? '\n(DRY-RUN) Corre con APPLY=1 para aplicar.' : '\n✅ Aplicado.');
    await mongoose.disconnect();
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
