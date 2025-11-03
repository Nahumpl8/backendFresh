// scripts/resetBimestre.js
require('dotenv').config();

const dns = require('dns');
// Fuerza IPv4 primero: soluciona ETIMEOUT en macOS / redes con IPv6 problemático
dns.setDefaultResultOrder('ipv4first');

const mongoose = require('mongoose');
mongoose.set('strictQuery', true);

const Clientes = require('../models/Clientes');

(async () => {
  const uri = process.env.MONGO_URL;
  if (!uri) {
    console.error('❌ Falta MONGO_URL en tu .env');
    process.exit(1);
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 15000, // cuánto esperar a que el cluster responda
      connectTimeoutMS: 15000,
      socketTimeoutMS: 30000,
      retryWrites: true,
      tls: true,
      family: 4, // fuerza IPv4
    });

    console.log('✅ Conectado a MongoDB');

    const result = await Clientes.updateMany(
      {},
      {
        $set: {
          puntos: 0,
          semanasSeguidas: 0,
          regaloDisponible: false,
        },
      }
    );

    console.log(`✔ Clientes modificados: ${result.modifiedCount}`);
  } catch (err) {
    console.error('❌ Error al resetear bimestre:', err);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Desconectado');
  }
})();
