const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');
const Clientes = require('../models/Clientes');
const notifyPassUpdate = require('../utils/pushApple');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const ejecutar = async () => {
  console.log("⚠️  ATENCIÓN: SE REINICIARÁN PUNTOS Y SELLOS (TARJETA ACTUAL) DE TODOS LOS CLIENTES.");
  console.log("ℹ️  Se conservan: sellosSemestrales, premioDisponible, rachas y premios pendientes.");
  console.log("📱  SE FORZARÁ LA ACTUALIZACIÓN EN IPHONES.");
  console.log("⏳  Tienes 3 segundos para cancelar (Ctrl + C)...");

  await new Promise(resolve => setTimeout(resolve, 3000));

  try {
    console.log("🔌 Conectando...");
    await mongoose.connect(process.env.MONGO_URL || process.env.DB_URI);

    console.log("🔄 Reiniciando puntos y sellos, forzando Timestamp...");

    const resultado = await Clientes.updateMany(
        {},
        {
            $set: {
                puntos: 0,
                sellos: 0,
                // 👇 Fuerza que los pases de Wallet detecten el cambio:
                updatedAt: new Date()
            }
        }
    );
    console.log(`✅ Datos actualizados para ${resultado.modifiedCount} clientes.`);

    console.log("📡 Enviando señal de actualización a Apple...");

    const clientesConWallet = await Clientes.find({ hasWallet: true });

    let enviados = 0;
    for (const cliente of clientesConWallet) {
        try {
            await notifyPassUpdate(cliente._id);
            enviados++;
            if (enviados % 10 === 0) process.stdout.write(`.`);
        } catch (error) {
            // Ignoramos errores individuales para no detener el proceso
        }
    }

    console.log(`\n🎉 ¡Listo! Se notificó a ${enviados} clientes.`);
    console.log("👉 Los pases se actualizarán automáticamente en los próximos minutos.");
    process.exit(0);

  } catch (err) {
    console.error("❌ Error fatal:", err);
    process.exit(1);
  }
};

ejecutar();
