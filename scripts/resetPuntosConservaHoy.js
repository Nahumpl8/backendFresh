// Reinicio ÚNICO de puntos conservando los generados por los pedidos de HOY.
//
// Para cada cliente:
//   - Si NO tiene pedidos hoy  -> puntos = 0
//   - Si tiene pedidos hoy     -> puntos = suma neta que esos pedidos aportaron
//     al saldo, es decir  Σ [ round((total - puntosUsados) * 1.2%) - puntosUsados ],
//     con piso en 0. (El pedido guarda total == totalFinal, el mismo valor que usa
//     la fórmula original en routes/pedidos.js.)
//
// puntosDobles no se guarda por pedido (promo rara) -> se calcula al 1.2% normal.
// NO toca sellos, rachas ni el histórico.
//
// Uso:
//   node scripts/resetPuntosConservaHoy.js          -> DRY-RUN (no escribe nada)
//   APPLY=1 node scripts/resetPuntosConservaHoy.js   -> aplica + respaldo + Wallet

const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const Clientes = require('../models/Clientes');
const Pedido = require('../models/Pedidos');
const notifyPassUpdate = require('../utils/pushApple');
const { notifyGoogleWalletUpdate } = require('../utils/pushGoogle');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const APPLY = process.env.APPLY === '1';

// Teléfono canónico: solo dígitos, últimos 10.
function telCanonico(tel) {
    const d = String(tel || '').replace(/\D/g, '');
    return d.length > 10 ? d.slice(-10) : d;
}

// Rango de "hoy" en horario de México (UTC-6): [00:00, 24:00) MX.
function rangoHoyMX() {
    const mxNow = new Date(Date.now() - 6 * 3600 * 1000);
    const y = mxNow.getUTCFullYear(), mo = mxNow.getUTCMonth(), d = mxNow.getUTCDate();
    const inicio = new Date(Date.UTC(y, mo, d, 6, 0, 0)); // 00:00 MX en UTC
    const fin = new Date(inicio.getTime() + 24 * 3600 * 1000);
    return { inicio, fin };
}

const ejecutar = async () => {
    const { inicio, fin } = rangoHoyMX();
    console.log(`\n${APPLY ? '🔴 MODO APPLY (SE ESCRIBIRÁ)' : '🟢 DRY-RUN (no se escribe nada)'}`);
    console.log(`📅 "Hoy" = ${inicio.toISOString()} → ${fin.toISOString()} (MX)\n`);

    const uri = process.env.MONGO_URL || process.env.DB_URI;
    console.log('🔑 URI presente:', uri ? 'sí (' + uri.slice(0, 16) + '...)' : 'NO');
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    console.log('🔌 Conectado.');

    // 1. Pedidos de hoy -> suma neta de puntos por teléfono
    const pedidosHoy = await Pedido.find({ createdAt: { $gte: inicio, $lt: fin } })
        .select('telefono total puntosUsados cliente createdAt');
    const deltaPorTel = {};
    for (const p of pedidosHoy) {
        const canon = telCanonico(p.telefono);
        if (!canon) continue;
        const usados = p.puntosUsados || 0;
        const efectivo = (p.total || 0) - usados;
        const nuevos = Math.round(efectivo * 0.012);
        const delta = nuevos - usados;
        deltaPorTel[canon] = (deltaPorTel[canon] || 0) + delta;
    }
    const telsConHoy = Object.keys(deltaPorTel);
    console.log(`🧾 Pedidos de hoy: ${pedidosHoy.length} (de ${telsConHoy.length} teléfonos distintos).`);

    // 2. Recorremos clientes y calculamos su saldo nuevo
    const clientes = await Clientes.find({}).select('telefono puntos hasWallet walletPlatform nombre');
    let sumaAntes = 0, sumaDespues = 0;
    const cambios = [];        // { cliente, antes, despues }
    const conservan = [];      // clientes que conservan algo (pidieron hoy)
    for (const c of clientes) {
        const antes = c.puntos || 0;
        const canon = telCanonico(c.telefono);
        const keep = deltaPorTel[canon];
        const despues = keep != null ? Math.max(0, keep) : 0;
        sumaAntes += antes;
        sumaDespues += despues;
        if (despues !== antes) cambios.push({ c, antes, despues });
        if (keep != null && despues > 0) conservan.push({ c, antes, despues });
    }

    console.log(`\n===== RESUMEN =====`);
    console.log(`👥 Clientes totales:            ${clientes.length}`);
    console.log(`✅ Conservan puntos (hoy):      ${conservan.length}`);
    console.log(`✏️  Clientes que cambian:        ${cambios.length}`);
    console.log(`💰 Puntos ANTES (suma):         ${sumaAntes.toLocaleString('es-MX')}`);
    console.log(`💰 Puntos DESPUÉS (suma):       ${sumaDespues.toLocaleString('es-MX')}`);
    console.log(`🗑️  Puntos que se borran:        ${(sumaAntes - sumaDespues).toLocaleString('es-MX')}`);

    console.log(`\n----- Muestra de los que CONSERVAN (máx 20) -----`);
    conservan
        .sort((a, b) => b.despues - a.despues)
        .slice(0, 20)
        .forEach(({ c, antes, despues }) => {
            console.log(`  ${(c.nombre || '(sin nombre)').padEnd(22)} tel ***${telCanonico(c.telefono).slice(-4)}  ${antes} → ${despues}`);
        });

    if (!APPLY) {
        console.log(`\n🟢 DRY-RUN terminado. Nada se escribió.`);
        console.log(`👉 Para aplicar:  APPLY=1 node scripts/resetPuntosConservaHoy.js\n`);
        await mongoose.disconnect();
        return; // sin process.exit: deja que stdout se vacíe y el proceso salga solo
    }

    // 3. APPLY: respaldo previo de TODOS los puntos actuales
    const dir = path.resolve(__dirname, '../backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const stamp = inicio.toISOString().slice(0, 10);
    const backupPath = path.join(dir, `puntos-backup-${stamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(
        clientes.map(c => ({ _id: c._id, telefono: c.telefono, puntos: c.puntos || 0 })), null, 2
    ));
    console.log(`\n💾 Respaldo escrito: ${backupPath}`);

    // 4. Escritura en bloque
    if (cambios.length > 0) {
        const ops = cambios.map(({ c, despues }) => ({
            updateOne: {
                filter: { _id: c._id },
                update: { $set: { puntos: despues, updatedAt: new Date() } },
            },
        }));
        const r = await Clientes.bulkWrite(ops);
        console.log(`✅ Actualizados: ${r.modifiedCount} clientes.`);
    } else {
        console.log('ℹ️  No hubo cambios que escribir.');
    }

    // 5. Refresco de Wallet solo para los que cambiaron y tienen pase
    const conWallet = cambios.filter(({ c }) => c.hasWallet);
    console.log(`📡 Refrescando Wallet de ${conWallet.length} clientes...`);
    let ok = 0;
    for (const { c } of conWallet) {
        try {
            await notifyPassUpdate(c._id);
            if (c.walletPlatform === 'google' || c.walletPlatform === 'both') {
                await notifyGoogleWalletUpdate(c._id);
            }
            ok++;
        } catch (e) { /* ignorar errores individuales */ }
    }
    console.log(`🎉 Listo. Wallet notificado a ${ok}/${conWallet.length}.`);

    await mongoose.disconnect();
};

ejecutar()
    .then(() => { process.exitCode = 0; })
    .catch(err => {
        console.error('❌ Error fatal:', err);
        process.exitCode = 1;
    });
