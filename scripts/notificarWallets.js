// scripts/notificarWallets.js
// Reenvía la señal de actualización a todos los pases de Apple Wallet
// (útil cuando un reseteo masivo actualizó datos pero falló la notificación).
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const dns = require('dns');
// Fuerza IPv4 primero: soluciona ETIMEOUT en macOS / redes con IPv6 problemático
dns.setDefaultResultOrder('ipv4first');

const mongoose = require('mongoose');
mongoose.set('strictQuery', true);

const Clientes = require('../models/Clientes');
const notifyPassUpdate = require('../utils/pushApple');

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL || process.env.DB_URI, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
      socketTimeoutMS: 30000,
      tls: true,
      family: 4,
    });
    console.log('✅ Conectado a MongoDB');

    const clientesConWallet = await Clientes.find({ hasWallet: true });
    console.log(`📡 Notificando a ${clientesConWallet.length} clientes con Wallet...`);

    let enviados = 0;
    for (const cliente of clientesConWallet) {
      try {
        await notifyPassUpdate(cliente._id);
        enviados++;
        if (enviados % 10 === 0) process.stdout.write('.');
      } catch (error) {
        // Ignoramos errores individuales para no detener el proceso
      }
    }

    console.log(`\n🎉 ¡Listo! Se notificó a ${enviados} clientes.`);
  } catch (err) {
    console.error('❌ Error fatal:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
