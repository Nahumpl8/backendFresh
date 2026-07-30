/**
 * Siembra la colección ColoniaEnvio desde scripts/coloniasSeed.json
 * (Pachuca de Soto + Mineral de la Reforma de SEPOMEX + fraccionamientos curados).
 *
 *   node scripts/seedColoniasEnvio.js          -> DRY-RUN (no escribe, solo cuenta)
 *   APPLY=1 node scripts/seedColoniasEnvio.js   -> upsert (no pisa costos ya editados)
 *   FORCE=1 APPLY=1 ...                          -> re-siembra costos/activo desde el JSON
 *
 * Upsert por (cp, colonia). Sin FORCE, si la colonia ya existe NO se toca (respeta lo
 * que el admin haya editado en el panel); solo inserta las nuevas.
 */
const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');
const ColoniaEnvio = require('../models/ColoniaEnvio');
const seed = require('./coloniasSeed.json');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DRY_RUN = process.env.APPLY !== '1';
const FORCE = process.env.FORCE === '1';

const ejecutar = async () => {
    const uri = process.env.MONGO_URL || process.env.DB_URI;
    if (!uri) { console.error('Falta MONGO_URL'); process.exit(1); }
    await mongoose.connect(uri);

    let insertados = 0, actualizados = 0, saltados = 0;
    for (const r of seed) {
        const filtro = { cp: r.cp, colonia: r.colonia };
        const existe = await ColoniaEnvio.findOne(filtro);
        if (!existe) {
            insertados++;
            if (!DRY_RUN) await ColoniaEnvio.create(r);
        } else if (FORCE) {
            actualizados++;
            if (!DRY_RUN) await ColoniaEnvio.updateOne(filtro, { $set: { municipio: r.municipio, costoEnvio: r.costoEnvio, gratisJueves: r.gratisJueves, activo: r.activo } });
        } else {
            saltados++;
        }
    }

    const total = await ColoniaEnvio.countDocuments();
    console.log(`Seed: ${seed.length} | insertar: ${insertados} | actualizar(FORCE): ${actualizados} | ya existen (saltados): ${saltados}`);
    console.log(`Total en la colección tras ${DRY_RUN ? 'DRY-RUN (no escrito)' : 'APLICAR'}: ${DRY_RUN ? total + ' (actual)' : total}`);
    const conCosto = await ColoniaEnvio.countDocuments({ costoEnvio: { $gt: 0 } });
    if (!DRY_RUN) console.log(`Con costo > 0: ${conCosto}`);

    await mongoose.disconnect();
    process.exit(0);
};

ejecutar().catch(err => { console.error(err); process.exit(1); });
