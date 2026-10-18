/**
 * Genera el PDF de lista de precios y lo guarda en disco.
 *
 * Uso:
 *   node scripts/generarListaPdf.js                 -> en la carpeta actual
 *   node scripts/generarListaPdf.js ~/Desktop       -> en el Escritorio
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { generarDesdeBase } = require('../utils/listaPdf');

(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    console.log(`base: ${mongoose.connection.db.databaseName} — generando…`);
    const t0 = Date.now();
    const pdf = await generarDesdeBase();
    const dir = process.argv[2] ? path.resolve(process.argv[2].replace(/^~/, process.env.HOME)) : process.cwd();
    const archivo = path.join(dir, `Lista Fresh Market ${new Date(pdf.generadoAt).toISOString().slice(0, 10)}.pdf`);
    fs.writeFileSync(archivo, pdf.buffer);
    console.log(`✅ ${archivo}`);
    console.log(`   ${pdf.paginas} páginas · ${pdf.tarjetas} productos · ${(pdf.buffer.length / 1048576).toFixed(1)} MB · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    if (pdf.sinFoto) console.log(`   ⚠️ ${pdf.sinFoto} productos sin foto válida en la base`);
    await mongoose.disconnect();
})().catch(async (e) => { console.error('❌', e.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
