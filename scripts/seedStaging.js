/**
 * Siembra de datos ficticios para el entorno de STAGING.
 *
 * Crea 5 clientes de prueba con puntos, sellos, pedidos y un premio de ruleta a
 * punto de caducar, para poder probar los flujos de Telegram sin tocar datos
 * reales.
 *
 * SEGURIDAD: se niega a correr si MONGO_URL no apunta a una base cuyo nombre
 * contenga "staging". Es la única barrera entre un despiste y 5 clientes
 * ficticios metidos en producción, así que no la quites ni la relajes.
 *
 * Uso:
 *   node scripts/seedStaging.js            -> DRY RUN (muestra lo que haría)
 *   APPLY=1 node scripts/seedStaging.js    -> escribe en la base
 *   APPLY=1 LIMPIAR=1 node scripts/seedStaging.js  -> borra los de prueba y los recrea
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Clientes = require('../models/Clientes');
const Pedido = require('../models/Pedidos');

dotenv.config();

const DRY_RUN = process.env.APPLY !== '1';
const LIMPIAR = process.env.LIMPIAR === '1';

// Prefijo reservado para datos de prueba: permite borrarlos sin tocar nada más.
const TEL_PREFIJO = '555000000';
const TELEFONOS = [1, 2, 3, 4, 5].map((n) => `${TEL_PREFIJO}${n}`);

const log = (...a) => console.log(...a);
const sep = () => log('─'.repeat(70));

/**
 * Comprueba que la URL apunta a una base de staging.
 * Mira el nombre de la BASE (el path), no la cadena entera: un host que por
 * casualidad contuviera "staging" no debe dar vía libre.
 */
function verificarEsStaging(url) {
    if (!url) return { ok: false, motivo: 'MONGO_URL no está definida' };

    let nombreBase;
    try {
        // mongodb+srv://user:pass@host/BASE?params
        const sinQuery = url.split('?')[0];
        nombreBase = sinQuery.substring(sinQuery.lastIndexOf('/') + 1);
    } catch (e) {
        return { ok: false, motivo: 'no se pudo leer el nombre de la base en MONGO_URL' };
    }

    if (!nombreBase) {
        return { ok: false, motivo: 'MONGO_URL no especifica una base de datos' };
    }
    if (!nombreBase.toLowerCase().includes('staging')) {
        return { ok: false, motivo: `la base se llama "${nombreBase}" y no contiene "staging"` };
    }
    return { ok: true, nombreBase };
}

function clientesDePrueba() {
    const ahora = new Date();
    const enDias = (n) => new Date(ahora.getTime() + n * 86400000);
    const haceDias = (n) => new Date(ahora.getTime() - n * 86400000);

    return [
        {
            nombre: 'Ana Prueba - Centro',
            telefono: TELEFONOS[0],
            direccion: 'Av. Juárez 100, Centro, Pachuca',
            colonia: 'Centro', cp: '42000',
            puntos: 150, sellos: 4, sellosSemestrales: 12,
            totalPedidos: 12, totalGastado: 5400,
            semanasSeguidas: 3,
            _nota: 'cliente activo con sellos a medias',
        },
        {
            nombre: 'Beto Prueba - Lindavista',
            telefono: TELEFONOS[1],
            direccion: 'Calle Pino 25, Lindavista, Pachuca',
            colonia: 'Lindavista', cp: '42083',
            puntos: 40, sellos: 8, sellosSemestrales: 8,
            premioDisponible: true,
            totalPedidos: 8, totalGastado: 3200,
            _nota: 'tarjeta de sellos completa (premio disponible)',
        },
        {
            nombre: 'Carla Prueba - Real del Monte',
            telefono: TELEFONOS[2],
            direccion: 'Camino Real 7, Real del Monte',
            colonia: 'Real del Monte', cp: '42130',
            puntos: 320, sellos: 2,
            totalPedidos: 25, totalGastado: 11800,
            // Premio de ruleta a punto de caducar: sirve para probar el aviso.
            //
            // OJO: va como STRING JSON, no como subdocumento. No es un capricho:
            // models/Clientes.js declara `premiosPendientes: [{ ..., type: String, ... }]`
            // y Mongoose interpreta ese `type:` como el tipo DEL ARRAY, no como un
            // campo llamado "type". Resultado: el array es `[String]` y cada premio
            // se guarda serializado. Los 113 clientes con premios en producción están
            // así, de modo que el seed replica la forma real; si sembráramos
            // subdocumentos estaríamos probando contra algo que no existe.
            // (Ver docs/bug-premiospendientes.md.)
            premiosPendientes: [JSON.stringify({
                source: 'roulette',
                key: 'seed-limon',
                label: '1 kg de limón de regalo',
                type: 'producto',
                value: 0,
                expiresAt: enDias(2),
                redeemed: false,
                spinId: 'seed-staging-001',
            })],
            _nota: 'premio de ruleta que caduca en 2 días',
        },
        {
            nombre: 'Diego Prueba - Sin compras',
            telefono: TELEFONOS[3],
            direccion: 'Privada Olivo 3, Colonia Periodistas, Pachuca',
            colonia: 'Periodistas', cp: '42060',
            puntos: 0, sellos: 0, totalPedidos: 0, totalGastado: 0,
            _nota: 'ficha sin pedidos (prueba de cliente nuevo)',
        },
        {
            nombre: 'Elena Prueba - Dormida',
            telefono: TELEFONOS[4],
            direccion: 'Blvd. Everardo Márquez 500, Pachuca',
            colonia: 'Ex Hacienda', cp: '42094',
            puntos: 90, sellos: 1,
            totalPedidos: 4, totalGastado: 1600,
            ultimaCompra: haceDias(75),
            segmentoReactivacion: 'dormido',
            _nota: 'sin comprar desde hace 75 días (prueba de reactivación)',
        },
    ];
}

function pedidosDePrueba() {
    const ahora = new Date();
    const haceDias = (n) => new Date(ahora.getTime() - n * 86400000);
    const fechaTexto = (d) =>
        d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
            .replace(/^(\w)/, (m) => m.toUpperCase());

    return [
        { cliente: 'Ana Prueba - Centro', telefono: TELEFONOS[0], direccion: 'Av. Juárez 100, Centro, Pachuca',
          despensa: 'Familiar', despensaQuantity: 1, total: 285, fecha: fechaTexto(haceDias(3)), _dias: 3 },
        { cliente: 'Ana Prueba - Centro', telefono: TELEFONOS[0], direccion: 'Av. Juárez 100, Centro, Pachuca',
          despensa: 'Premium', despensaQuantity: 1, total: 485, fecha: fechaTexto(haceDias(10)), _dias: 10 },
        { cliente: 'Beto Prueba - Lindavista', telefono: TELEFONOS[1], direccion: 'Calle Pino 25, Lindavista, Pachuca',
          despensa: 'Especial', despensaQuantity: 2, total: 740, fecha: fechaTexto(haceDias(5)), _dias: 5 },
        { cliente: 'Carla Prueba - Real del Monte', telefono: TELEFONOS[2], direccion: 'Camino Real 7, Real del Monte',
          despensa: 'Jumbo', despensaQuantity: 1, total: 385, fecha: fechaTexto(haceDias(2)), _dias: 2 },
        { cliente: 'Carla Prueba - Real del Monte', telefono: TELEFONOS[2], direccion: 'Camino Real 7, Real del Monte',
          despensa: 'Pedido', despensaQuantity: 1, total: 240, fecha: fechaTexto(haceDias(2)), _dias: 2 },
        { cliente: 'Elena Prueba - Dormida', telefono: TELEFONOS[4], direccion: 'Blvd. Everardo Márquez 500, Pachuca',
          despensa: 'Familiar', despensaQuantity: 1, total: 285, fecha: fechaTexto(haceDias(75)), _dias: 75 },
    ];
}

(async () => {
    sep();
    const check = verificarEsStaging(process.env.MONGO_URL);
    if (!check.ok) {
        console.error('🛑 ABORTADO: ' + check.motivo);
        console.error('   Este script SOLO puede correr contra una base de staging.');
        console.error('   Si de verdad querías sembrar, apunta MONGO_URL a freshapi_staging.');
        process.exit(1);
    }
    log(`✅ Base verificada: "${check.nombreBase}" (contiene "staging")`);
    log(DRY_RUN
        ? '🔍 DRY RUN — no se escribe nada. Para aplicar: APPLY=1 node scripts/seedStaging.js'
        : '✍️  ESCRIBIENDO en la base de staging');
    sep();

    await mongoose.connect(process.env.MONGO_URL);

    const clientes = clientesDePrueba();
    const pedidos = pedidosDePrueba();

    if (LIMPIAR) {
        const filtro = { telefono: { $regex: `^${TEL_PREFIJO}` } };
        const nC = await Clientes.countDocuments(filtro);
        const nP = await Pedido.countDocuments(filtro);
        log(`🧹 Limpieza: ${nC} clientes y ${nP} pedidos de prueba`);
        if (!DRY_RUN) {
            await Clientes.deleteMany(filtro);
            await Pedido.deleteMany(filtro);
            log('   borrados');
        }
    }

    log('\nClientes a sembrar:');
    for (const c of clientes) {
        const existe = await Clientes.findOne({ telefono: c.telefono });
        log(`  ${c.telefono}  ${c.nombre.padEnd(34)} ${existe ? '(ya existe, se omite)' : '(nuevo)'}  — ${c._nota}`);
        if (DRY_RUN || existe) continue;
        const { _nota, ...datos } = c;
        await Clientes.create({ ...datos, fechaAlta: new Date(), canalPreferido: 'whatsapp' });
    }

    log('\nPedidos a sembrar:');
    for (const p of pedidos) {
        const { _dias, ...datos } = p;
        const createdAt = new Date(Date.now() - _dias * 86400000);
        const existe = await Pedido.findOne({ telefono: p.telefono, fecha: p.fecha, despensa: p.despensa });
        log(`  ${p.telefono}  ${String(p.despensa).padEnd(10)} $${String(p.total).padEnd(5)} hace ${_dias} días  ${existe ? '(ya existe)' : '(nuevo)'}`);
        if (DRY_RUN || existe) continue;
        // createdAt explícito: las métricas y el segmento "dormido" dependen de él
        await Pedido.create({ ...datos, fuente: 'desconocido', createdAt, updatedAt: createdAt });
    }

    sep();
    log(DRY_RUN ? '🔍 DRY RUN terminado — la base NO se tocó.' : '✅ Siembra aplicada.');
    log(`   Teléfonos de prueba: ${TELEFONOS.join(', ')}`);
    await mongoose.disconnect();
})().catch(async (e) => {
    console.error('❌ Error:', e.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
