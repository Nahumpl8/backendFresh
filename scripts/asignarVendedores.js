const mongoose = require('mongoose');
const path = require('path'); // 👈 Importamos path
const dotenv = require('dotenv');
const Clientes = require('../models/Clientes'); 

// 👇 Le decimos explícitamente dónde está el .env (un nivel arriba)
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const ejecutar = async () => {
  try {
    console.log("⏳ Conectando a la base de datos...");
    await mongoose.connect(process.env.MONGO_URL || process.env.DB_URI);
    console.log("✅ Conectado.");

    console.log("🔄 Asignando 'Fresh Market' a clientes sin vendedor...");
    
    // Busca clientes donde el campo vendedor no exista, sea null o esté vacío
    const resultado = await Clientes.updateMany(
        { 
            $or: [
                { vendedor: { $exists: false } },
                { vendedor: null },
                { vendedor: "" }
            ]
        },
        { $set: { vendedor: 'Fresh Market' } }
    );

    console.log(`🎉 ¡Listo! Clientes actualizados: ${resultado.modifiedCount}`);
    
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }
};

ejecutar();