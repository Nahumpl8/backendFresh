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

dotenv.config();

const DRY_RUN = process.env.APPLY !== '1';

// --- Normalización de texto: minúsculas, sin acentos/ñ, espacios colapsados ---
const normalize = (s) =>
    String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // quita acentos y la tilde de la ñ
        .replace(/[^a-z0-9\s]/g, ' ')     // signos -> espacio
        .replace(/\s+/g, ' ')
        .trim();

// --- Tabla de zonas (keyword -> costo). Se evalúan en orden; primer match gana. ---
// Keywords escritas "bonitas"; se normalizan al cargar para comparar.
const ZONAS_RAW = [
    // AZUL: $35, gratis los jueves
    { keyword: 'pachuquilla', costoEnvio: 35, gratisJueves: true },
    { keyword: 'virreyes', costoEnvio: 35, gratisJueves: true },
    { keyword: 'la calera', costoEnvio: 35, gratisJueves: true },
    { keyword: 'nopalapa', costoEnvio: 35, gratisJueves: true },
    { keyword: 'rinconada de los angeles', costoEnvio: 35, gratisJueves: true },
    { keyword: 'xochihuacan', costoEnvio: 35, gratisJueves: true },
    { keyword: 'hacienda margarita', costoEnvio: 35, gratisJueves: true },
    { keyword: 'hda margarita', costoEnvio: 35, gratisJueves: true },
    { keyword: 'margarita', costoEnvio: 35, gratisJueves: true },
    { keyword: 'real madeira', costoEnvio: 35, gratisJueves: true },
    { keyword: 'lindavista', costoEnvio: 35, gratisJueves: true },
    { keyword: 'santa matilde', costoEnvio: 35, gratisJueves: true },
    { keyword: 'matilde', costoEnvio: 35, gratisJueves: true },
    { keyword: 'vinedos', costoEnvio: 35, gratisJueves: true },
    { keyword: 'san alfonso', costoEnvio: 35, gratisJueves: true },
    { keyword: 'amores de don juan', costoEnvio: 35, gratisJueves: true },
    { keyword: 'real navarra', costoEnvio: 35, gratisJueves: true },

    // AMARILLO: $25, siempre se cobra
    { keyword: 'renacimiento', costoEnvio: 25, gratisJueves: false },
    { keyword: 'antorcha', costoEnvio: 25, gratisJueves: false },
    { keyword: 'los pirules', costoEnvio: 25, gratisJueves: false },
    { keyword: 'crisol', costoEnvio: 25, gratisJueves: false },
    { keyword: 'aves del paraiso', costoEnvio: 25, gratisJueves: false },

    // AMARILLO: $40, siempre se cobra
    { keyword: 'loma bonita', costoEnvio: 40, gratisJueves: false },
    { keyword: 'la loma', costoEnvio: 40, gratisJueves: false },
    { keyword: 'barrio del judio', costoEnvio: 40, gratisJueves: false },
    { keyword: 'banus', costoEnvio: 40, gratisJueves: false },
    { keyword: 'universidad del futbol', costoEnvio: 40, gratisJueves: false },
    { keyword: 'paseo de solares', costoEnvio: 40, gratisJueves: false },
    { keyword: 'la concepcion', costoEnvio: 40, gratisJueves: false },
    { keyword: 'san guillermo la reforma', costoEnvio: 40, gratisJueves: false },
    { keyword: 'san guillermo', costoEnvio: 40, gratisJueves: false },
    { keyword: 'azoyotla de ocampo', costoEnvio: 40, gratisJueves: false },
    { keyword: 'azoyotla', costoEnvio: 40, gratisJueves: false },
    { keyword: 'mirador', costoEnvio: 40, gratisJueves: false },
];

const ZONAS = ZONAS_RAW.map((z) => ({ ...z, keyword: normalize(z.keyword) }));

// Devuelve { costoEnvio, gratisJueves, keyword } de la primera zona que aparezca
// como substring en el texto normalizado, o null si no hay match.
const matchZona = (texto) => {
    const t = normalize(texto);
    if (!t) return null;
    for (const z of ZONAS) {
        if (z.keyword && t.includes(z.keyword)) return z;
    }
    return null;
};

// Sufijo del nombre después del último " - " (ej. "Nahum Pérez - Lindavista" -> "Lindavista")
const sufijoNombre = (nombre) => {
    const s = String(nombre || '');
    const idx = s.lastIndexOf(' - ');
    return idx >= 0 ? s.slice(idx + 3) : '';
};

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
        const zonaPrincipal = matchZona(`${sufijoNombre(c.nombre)} ${c.direccion}`);
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
            const zonaExtra = matchZona(`${addr.alias || ''} ${addr.direccion || ''}`);
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
