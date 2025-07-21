const mongoose = require('mongoose');
const Cliente = require('../models/Clientes');
const dotenv = require('dotenv');

dotenv.config();

mongoose.connect(process.env.MONGO_URL).then(async () => {
  const clientes = await Cliente.find();
  let actualizados = 0;

  for (const cliente of clientes) {
    if (!cliente.telefono) continue;

    // Extrae todos los números de teléfono con 10+ dígitos
    const numeros = cliente.telefono
      .split(/[\s,/o|]+/i) // divide por espacios, coma, slash, "o", etc.
      .map(t =>
        t
          .replace(/\D+/g, '') // quita todo lo que no sea dígito
          .replace(/^52/, '')  // remueve lada de México si está al inicio
          .trim()
      )
      .filter(num => num.length >= 10); // solo deja números válidos

    if (numeros.length > 0) {
      cliente.telefono = numeros[0];
      cliente.telefonoSecundario = numeros[1] || null;
      await cliente.save();
      actualizados++;
      console.log(`✅ Cliente ${cliente.nombre} actualizado`);
    } else {
      console.log(`⚠️  Cliente ${cliente.nombre} tiene teléfono no válido: ${cliente.telefono}`);
    }
  }

  console.log(`✔️  Teléfonos actualizados correctamente: ${actualizados}`);
  mongoose.disconnect();
});
