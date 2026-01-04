const mongoose = require('mongoose');
const path = require('path'); // 👈 Importante para no tener errores de ruta
const dotenv = require('dotenv');
const Clientes = require('../models/Clientes');

// 👇 Busca el .env en la carpeta de arriba
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const ejecutar = async () => {
  console.log("⚠️  ATENCIÓN: ESTÁS A PUNTO DE BORRAR LOS PUNTOS DE TODOS LOS CLIENTES.");
  console.log("⏳  Tienes 3 segundos para cancelar (Ctrl + C)...");
  
  await new Promise(resolve => setTimeout(resolve, 3000));

  try {
    console.log("🔌 Conectando...");
    await mongoose.connect(process.env.MONGO_URL || process.env.DB_URI);
    
    const resultado = await Clientes.updateMany(
        {}, 
        { $set: { puntos: 0 } }
    );

    console.log(`🧹 Puntos reiniciados a 0 para ${resultado.modifiedCount} clientes.`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }
};

ejecutar();