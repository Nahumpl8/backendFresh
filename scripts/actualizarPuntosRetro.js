const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Cliente = require('../models/Clientes');
const Pedido = require('../models/Pedidos');
const CASHBACK_RATE = 0.015;


dotenv.config();

const obtenerSemanaISO = (fecha) => {
  const d = new Date(Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNo.toString().padStart(2, '0')}`;
};

const calcularSemanasSeguidas = (semanas) => {
  const ordenadas = [...semanas].sort().reverse();
  let contador = 0;
  let actual = new Date();
  for (let i = 0; i < ordenadas.length; i++) {
    const semanaEsperada = obtenerSemanaISO(actual);
    if (ordenadas[i] === semanaEsperada) {
      contador++;
      actual.setDate(actual.getDate() - 7);
    } else {
      break;
    }
  }
  return contador;
};

const ejecutar = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✅ Conectado a MongoDB');

    const clientes = await Cliente.find();
    let totalActualizados = 0;

    for (const cliente of clientes) {
      const pedidos = await Pedido.find({
        telefono: cliente.telefono,
        createdAt: {
          $gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
        }
      });

      const totalGastado = pedidos.reduce((acc, p) => acc + (p.total || 0), 0);
      const puntos = Math.floor(totalGastado * CASHBACK_RATE);
      const totalPedidos = pedidos.length;

      const semanas = [...new Set(pedidos.map(p => obtenerSemanaISO(new Date(p.createdAt))))];
      const semanasSeguidas = calcularSemanasSeguidas(semanas);
      const ultimaSemana = semanas.sort().reverse()[0] || null;

      const regaloDisponible = semanasSeguidas >= 4;

      await Cliente.findByIdAndUpdate(cliente._id, {
        $set: {
          puntos,
          totalGastado,
          totalPedidos,
          semanasSeguidas,
          ultimaSemanaRegistrada: ultimaSemana,
          regaloDisponible,
        }
      });

      console.log(`✔️ ${cliente.nombre} (${cliente.telefono}): ${puntos} pts, ${totalPedidos} pedidos, ${semanasSeguidas} semanas seguidas → regalo: ${regaloDisponible ? '✅' : '❌'}`);

      totalActualizados++;
    }

    console.log(`\n🏁 Clientes actualizados: ${totalActualizados}`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
};

ejecutar();