/**
 * Crea el índice único de `telegramId` en la colección de clientes.
 *
 * ¿Por qué un script y no `ClienteSchema.index(...)`?
 *
 * Porque si Mongoose no puede crear un índice al arrancar, SOLO lo registra en
 * un evento y el servidor sigue tan tranquilo. Comprobado: con dos documentos
 * duplicados, el proceso no se cae y el índice simplemente no existe. Es decir,
 * el servidor arrancaría creyendo que `telegramId` es único sin serlo, y el
 * problema aparecería meses después con dos fichas apuntando al mismo chat.
 *
 * Aquí se crea una vez, a mano, y si falla se ve.
 *
 * Por qué PARCIAL y no `sparse`: `sparse` solo ignora los documentos donde la
 * clave NO EXISTE. Las 8,171 fichas tienen `telegramId: null` explícito por el
 * `default: null` del esquema, así que un índice sparse+unique las indexaría
 * todas con null y fallaría por duplicados. El filtro parcial por tipo string
 * deja fuera los null de verdad.
 *
 * Uso:
 *   node scripts/crearIndiceTelegram.js          -> DRY RUN (solo diagnostica)
 *   APPLY=1 node scripts/crearIndiceTelegram.js  -> crea el índice
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Clientes = require('../models/Clientes');

dotenv.config();

const DRY_RUN = process.env.APPLY !== '1';
const NOMBRE = 'telegramId_unico';

(async () => {
    if (!process.env.MONGO_URL) { console.error('🛑 Falta MONGO_URL'); process.exit(1); }
    await mongoose.connect(process.env.MONGO_URL);

    const base = mongoose.connection.db.databaseName;
    console.log('─'.repeat(64));
    console.log(`base: ${base}`);
    console.log(DRY_RUN ? '🔍 DRY RUN — no se crea nada' : '✍️  CREANDO el índice');
    console.log('─'.repeat(64));

    const col = Clientes.collection;

    const existentes = await col.indexes();
    const ya = existentes.find((i) => i.name === NOMBRE);
    if (ya) {
        console.log(`✅ El índice "${NOMBRE}" ya existe:`, JSON.stringify(ya.key), ya.unique ? '(único)' : '');
        await mongoose.disconnect();
        return;
    }

    // Antes de crear: ¿hay duplicados que lo impedirían?
    const dups = await col.aggregate([
        { $match: { telegramId: { $type: 'string' } } },
        { $group: { _id: '$telegramId', n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
    ]).toArray();

    const conTelegram = await col.countDocuments({ telegramId: { $type: 'string' } });
    console.log(`clientes con telegramId (string): ${conTelegram}`);
    console.log(`valores duplicados: ${dups.length}`);
    if (dups.length) {
        console.log('🛑 Hay duplicados; el índice único no se puede crear hasta resolverlos:');
        for (const d of dups.slice(0, 10)) console.log(`   "${d._id}" aparece ${d.n} veces`);
        await mongoose.disconnect();
        process.exit(1);
    }

    if (DRY_RUN) {
        console.log(`\n[DRY RUN] se crearía: { telegramId: 1 } único, parcial sobre strings`);
        console.log('Para aplicar: APPLY=1 node scripts/crearIndiceTelegram.js');
        await mongoose.disconnect();
        return;
    }

    await col.createIndex(
        { telegramId: 1 },
        { unique: true, partialFilterExpression: { telegramId: { $type: 'string' } }, name: NOMBRE },
    );
    const despues = await col.indexes();
    const creado = despues.find((i) => i.name === NOMBRE);
    console.log(creado ? `✅ Índice "${NOMBRE}" creado` : '❌ No se pudo verificar la creación');

    await mongoose.disconnect();
})().catch(async (e) => {
    console.error('❌ Error:', e.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
