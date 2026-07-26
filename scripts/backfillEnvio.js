/**
 * Backfill de costo de envío por dirección.
 *
 * Recorre todos los clientes e infiere `costoEnvio` y `gratisJueves` (zona azul,
 * gratis los jueves) a partir del texto de la dirección y del sufijo del nombre
 * (lo que va después del " - ", ej. "Nahum Pérez - Lindavista").
 *
 * Aplica tanto a la dirección principal (nivel raíz del cliente) como a cada
 * entrada de `misDirecciones`. Lo que no se logre identificar se deja intacto
 * (se llenará a mano después).
 *
 * Uso:
 *   node scripts/backfillEnvio.js            -> DRY RUN (solo muestra, no escribe)
 *   APPLY=1 node scripts/backfillEnvio.js    -> aplica los cambios en la BD
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Cliente = require('../models/Clientes');
const { inferEnvioPrincipal, inferEnvioDireccion } = require('../utils/envioZonas');

dotenv.config();

const DRY_RUN = process.env.APPLY !== '1';

async function run() {
    if (!process.env.MONGO_URL) {
        console.error('❌ Falta MONGO_URL en el .env');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URL);
    console.log(`🔌 Conectado. Modo: ${DRY_RUN ? 'DRY RUN (no escribe)' : 'APLICANDO CAMBIOS'}`);

    const clientes = await Cliente.find().select('nombre direccion misDirecciones costoEnvio gratisJueves');
    console.log(`👥 Clientes: ${clientes.length}`);

    let principalMatch = 0;
    let principalSinMatch = 0;
    let dirExtraMatch = 0;
    let dirExtraSinMatch = 0;
    let clientesTocados = 0;
    const ejemplos = [];

    for (const c of clientes) {
        const set = {};

        // --- Dirección principal: sufijo del nombre + dirección ---
        const zonaPrincipal = inferEnvioPrincipal({ nombre: c.nombre, direccion: c.direccion });
        if (zonaPrincipal) {
            if (c.costoEnvio !== zonaPrincipal.costoEnvio) set.costoEnvio = zonaPrincipal.costoEnvio;
            if (c.gratisJueves !== zonaPrincipal.gratisJueves) set.gratisJueves = zonaPrincipal.gratisJueves;
            principalMatch++;
            if (ejemplos.length < 15) {
                ejemplos.push(`  ✔ ${c.nombre} → $${zonaPrincipal.costoEnvio}${zonaPrincipal.gratisJueves ? ' (jueves gratis)' : ''}  [${zonaPrincipal.keyword}]`);
            }
        } else {
            principalSinMatch++;
        }

        // --- Direcciones extra ---
        const dirs = Array.isArray(c.misDirecciones) ? c.misDirecciones : [];
        dirs.forEach((addr, i) => {
            const zonaExtra = inferEnvioDireccion({ alias: addr.alias, direccion: addr.direccion });
            if (zonaExtra) {
                if (addr.costoEnvio !== zonaExtra.costoEnvio) set[`misDirecciones.${i}.costoEnvio`] = zonaExtra.costoEnvio;
                if (addr.gratisJueves !== zonaExtra.gratisJueves) set[`misDirecciones.${i}.gratisJueves`] = zonaExtra.gratisJueves;
                dirExtraMatch++;
            } else {
                dirExtraSinMatch++;
            }
        });

        if (Object.keys(set).length > 0) {
            clientesTocados++;
            if (!DRY_RUN) {
                await Cliente.updateOne({ _id: c._id }, { $set: set });
            }
        }
    }

    console.log('\n--- Ejemplos de match (principal) ---');
    ejemplos.forEach((e) => console.log(e));

    console.log('\n--- Resumen ---');
    console.log(`Principal   → con match: ${principalMatch} | sin match: ${principalSinMatch}`);
    console.log(`Dir. extra  → con match: ${dirExtraMatch} | sin match: ${dirExtraSinMatch}`);
    console.log(`Clientes con cambios: ${clientesTocados}`);
    console.log(DRY_RUN
        ? '\n⚠️  DRY RUN: no se escribió nada. Corre con  APPLY=1 node scripts/backfillEnvio.js  para aplicar.'
        : '\n✅ Cambios aplicados.');

    await mongoose.disconnect();
    process.exit(0);
}

run().catch((err) => {
    console.error('❌ Error:', err);
    process.exit(1);
});
