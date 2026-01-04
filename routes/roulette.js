const router = require('express').Router();
const Clientes = require('../models/Clientes');
const RouletteSpin = require('../models/RouletteSpin');

// Configuración de premios (Probabilidades)
// Total weights = 100 (aprox)
const PRIZES = [
  { key: "no_win", label: "¡Sigue participando!", weight: 30, color: "#cccccc", value: 0, type: "none" },
  { key: "15off", label: "Descuento $15 MXN", weight: 20, color: "#ffd166", value: 20, type: "discount" },
  { key: "25off", label: "Descuento $25 MXN", weight: 10, color: "#f4978e", value: 25, type: "discount" },
  { key: "product", label: "300g de Papas a la Francesa", weight: 20, color: "#a8dadc", value: 0, type: "product" },
  { key: "cheese", label: "250g de Queso Canasto", weight: 20, color: "#90be6d", value: 0, type: "product" },
];

function weightedPick(items) {
  const total = items.reduce((a, b) => a + b.weight, 0);
  let r = Math.random() * total;
  for (const it of items) { r -= it.weight; if (r <= 0) return it; }
  return items[items.length - 1];
}

// ==========================================
// 🎡 1. GIRAR RULETA (POST)
// ==========================================
router.post('/girar', async (req, res) => {
  try {
    const { clienteId } = req.body; // El frontend debe mandar el ID o el Teléfono

    // Buscamos al cliente
    // Nota: Si mandas telefono, cambia esto a findOne({ telefono: ... })
    const cliente = await Clientes.findById(clienteId);

    if (!cliente) return res.status(404).json({ error: "Cliente no encontrado" });

    // --- 👮 VALIDACIONES ESTRICTAS ---

    // 1. Mínimo 6 Sellos Semestrales (Fidelidad Real)
    if ((cliente.sellosSemestrales || 0) < 6) {
      return res.status(400).json({
        error: `Nivel insuficiente. Necesitas 6 sellos en el semestre (Tienes: ${cliente.sellosSemestrales || 0}).`
      });
    }

    // 2. Constancia (Racha activa > 1 semana)
    // Esto confirma que pidió la semana pasada y la antepasada (o similar)
    if ((cliente.semanasSeguidas || 0) < 2) {
      return res.status(400).json({
        error: "Debes tener una racha activa (haber pedido la semana pasada)."
      });
    }

    // 3. Costo: 10 Puntos
    if ((cliente.puntos || 0) < 10) {
      return res.status(400).json({
        error: `Puntos insuficientes. Costo: 10 (Tienes: ${cliente.puntos}).`
      });
    }

    // --- ✅ TODO OK: EJECUTAR GIRO ---

    // A. Cobrar
    cliente.puntos -= 10;

    // B. Seleccionar Premio
    const prize = weightedPick(PRIZES);

    // C. Registrar en Historial (RouletteSpin Collection)
    const spinRecord = await RouletteSpin.create({
      telefono: cliente.telefono,
      prizeKey: prize.key,
      prizeLabel: prize.label,
      prizeType: prize.type,
      prizeValue: prize.value,
      pointsAtSpin: cliente.puntos + 10, // Puntos que tenía antes de gastar
      eligibility: 'points_rule'
    });

    // D. Guardar en Cliente si ganó algo
    let resultadoMsg = "Suerte para la próxima.";

    if (prize.type !== 'none') {
      const fechaExp = new Date();
      fechaExp.setDate(fechaExp.getDate() + 7); // Caduca en 7 días

      cliente.premiosPendientes.push({
        label: prize.label,
        type: prize.type,
        value: prize.value,
        expiresAt: fechaExp,
        redeemed: false,
        spinId: spinRecord._id.toString()
      });
      resultadoMsg = `¡Ganaste: ${prize.label}!`;
    }

    // E. Guardar cambios en Cliente
    await cliente.save();

    res.json({
      success: true,
      mensaje: resultadoMsg,
      premio: prize,
      nuevosPuntos: cliente.puntos,
      premiosPendientes: cliente.premiosPendientes
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error interno al girar la ruleta" });
  }
});

// ==========================================
// 🎟️ 2. CANJEAR PREMIO (POST)
// ==========================================
// Se llama cuando haces el pedido y seleccionas el premio
router.post('/canjear', async (req, res) => {
  try {
    const { telefono, spinId } = req.body;

    // Buscamos dentro del array de premiosPendientes usando el ID del spin
    const result = await Clientes.updateOne(
      {
        telefono: { $regex: telefono + '$' },
        "premiosPendientes.spinId": spinId
      },
      {
        $set: {
          "premiosPendientes.$.redeemed": true,
          "premiosPendientes.$.redeemedAt": new Date()
        }
      }
    );

    if (result.modifiedCount > 0) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Premio no encontrado o ya canjeado" });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json(err);
  }
});

module.exports = router;