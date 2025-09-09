// routes/roulette.js
const router = require('express').Router();
const Clientes = require('../models/Clientes');
const Pedido = require('../models/Pedidos');
const RouletteSpin = require('../models/RouletteSpin');

// routes/roulette.js
const PRIZES = [
  { key: "5off", label: "$5 de descuento", weight: 22, color: "#ffd166", value: 5, type: "discount" },
  { key: "10off", label: "$10 de descuento", weight: 14, color: "#f4978e", value: 10, type: "discount" },
  { key: "fries", label: "300g Papas francesa", weight: 14, color: "#a8dadc", value: 1, type: "item" },
  { key: "chorizo", label: "250g Chorizo Huasteco", weight: 12, color: "#bde0fe", value: 1, type: "item" },
  { key: "lemon", label: "1kg de Limón de regalo", weight: 22, color: "#ffd6a5", value: 1, type: "item" },
  { key: "25off", label: "$25 de descuento", weight: 6, color: "#9bf6ff", value: 25, type: "discount" },
];

// === Utilidades de fechas ===
function formatearFechaEs(d) {
  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  return `${dias[d.getDay()]}, ${d.getDate()} ${meses[d.getMonth()]} ${d.getFullYear()}`;
}
function fechasSemanaPasada_MiercolesADomingo() {
  const hoy = new Date();
  const base = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  const dow = (base.getDay() + 6) % 7; // 0=lunes
  const lunesEsta = new Date(base); lunesEsta.setDate(base.getDate() - dow);
  const lunesPasada = new Date(lunesEsta); lunesPasada.setDate(lunesEsta.getDate() - 7);
  const out = [];
  for (let offset of [2, 3, 4, 5]) { const d = new Date(lunesPasada); d.setDate(lunesPasada.getDate() + offset); out.push(formatearFechaEs(d)); }
  const dom = new Date(lunesPasada); dom.setDate(lunesPasada.getDate() + 6); out.push(formatearFechaEs(dom));
  return out;
}

async function hizoPedidoEnFechas(telefono, fechasSemana) {
  // Opción rápida por string "fecha"
  const p = await Pedido.findOne({ telefono: { $regex: telefono + '$' }, fecha: { $in: fechasSemana } }).sort({ _id: -1 });
  if (p) return true;
  // Si tienes createdAt confiable, podrías calcular el rango exacto y usarlo aquí.
  return false;
}

function weightedPick(items) {
  const total = items.reduce((a, b) => a + b.weight, 0);
  let r = Math.random() * total;
  for (const it of items) { r -= it.weight; if (r <= 0) return it; }
  return items[items.length - 1];
}

// === Elegibilidad: pedido semana pasada + >10 puntos, o token ===
router.get('/eligibility/:telefono', async (req, res) => {
  try {
    const telefono = req.params.telefono.replace(/\D/g, '').replace(/^52/, '').trim();
    const cliente = await Clientes.findOne({ telefono: { $regex: telefono + '$' } });
    if (!cliente) return res.status(404).json({ ok: false, eligible: false, reason: 'Cliente no encontrado' });

    const fechasSemana = fechasSemanaPasada_MiercolesADomingo();
    const hizo = await hizoPedidoEnFechas(telefono, fechasSemana);
    const puntos = Number(cliente.puntos || 0);
    const tokens = Number(cliente.ruletaTokens || 0);

    const byRule = (hizo && puntos > 10);
    const byToken = tokens > 0;
    const eligible = byRule || byToken;

    // Política: si hay token, es gratis y se consumirá el token
    const spinCost = byToken ? 0 : 5;
    const canAfford = byToken ? true : puntos >= spinCost;

    res.json({
      ok: true,
      eligible,
      byRule,
      byToken,
      spinCost,
      canAfford,
      reasons: { hizoPedidoSemanaPasada: hizo, puntosMayorA10: puntos > 10, tieneToken: tokens > 0 },
      points: puntos,
      tokens,
      policy: 'token_if_available',
      fechasValidas: fechasSemana
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, eligible: false, reason: 'Error del servidor' });
  }
});

// === Spin: servidor decide premio y registra (sin transacciones) ===
router.post('/spin', async (req, res) => {
  try {
    const rawTel = req.body?.telefono;
    if (!rawTel) return res.status(400).json({ ok: false, msg: 'telefono requerido' });

    const t = rawTel.toString().replace(/\D/g, '').replace(/^52/, '').trim();
    const cliente = await Clientes.findOne({ telefono: { $regex: t + '$' } });
    if (!cliente) return res.status(404).json({ ok: false, msg: 'Cliente no encontrado' });

    const fechasSemana = fechasSemanaPasada_MiercolesADomingo();
    const hizo = await hizoPedidoEnFechas(t, fechasSemana);
    const puntos = Number(cliente.puntos || 0);
    const tokens = Number(cliente.ruletaTokens || 0);

    const byRule = (hizo && puntos > 10);
    const byToken = tokens > 0;

    if (!byRule && !byToken) {
      return res.status(403).json({
        ok: false,
        msg: 'No elegible para girar',
        detail: { hizoPedidoSemanaPasada: hizo, puntosMayorA10: puntos > 10, tokens }
      });
    }

    const spinCostIfRule = 5;

    const session = await Clientes.startSession();
    let spinDoc, prize, prizeIndex, clienteAfter, usedToken = false, chargedPoints = 0;

    await session.withTransaction(async () => {
      // 1) Intentar usar token si hay (gratis)
      if (byToken) {
        const updated = await Clientes.findOneAndUpdate(
          { _id: cliente._id, ruletaTokens: { $gte: 1 } },
          { $inc: { ruletaTokens: -1 } },
          { new: true, session }
        );
        if (!updated) throw new Error('NO_TOKEN_AVAILABLE');
        clienteAfter = updated;
        usedToken = true;
      } else {
        // 2) Entra por regla: cobrar 5 puntos
        if (puntos < spinCostIfRule) throw new Error('NO_BALANCE');
        const updated = await Clientes.findOneAndUpdate(
          { _id: cliente._id, puntos: { $gte: spinCostIfRule } },
          { $inc: { puntos: -spinCostIfRule } },
          { new: true, session }
        );
        if (!updated) throw new Error('NO_BALANCE');
        clienteAfter = updated;
        chargedPoints = spinCostIfRule;
      }

      // Elegir premio
      prize = weightedPick(PRIZES);
      prizeIndex = PRIZES.findIndex(p => p.key === prize.key);

      // Registrar spin
      const created = await RouletteSpin.create([{
        telefono: t,
        prizeKey: prize.key,
        prizeLabel: prize.label,
        prizeType: prize.type,
        prizeValue: prize.value,
        usedToken,
        pointsAtSpin: puntos,
        eligibility: usedToken ? 'token' : 'rule'
      }], { session });
      spinDoc = created[0];

      // Guardar premio pendiente si aplica
      if (prize.type !== 'none') {
        const expires = new Date();
        expires.setMonth(expires.getMonth() + 1);

        const premioObj = {
          source: 'roulette',
          key: prize.key, label: prize.label, type: prize.type, value: prize.value,
          expiresAt: expires, redeemed: false, spinId: spinDoc._id
        };

        await Clientes.updateOne(
          { _id: cliente._id },
          { $push: { premiosPendientes: JSON.stringify(premioObj) } }, // 👈 guardar como string
          { session }
        );
      }

      res.json({
        ok: true,
        spinId: spinDoc._id,
        prize: { key: prize.key, label: prize.label, type: prize.type, value: prize.value, index: prizeIndex },
        segments: PRIZES.map(p => ({ key: p.key, label: p.label, color: p.color })),
        usedToken,
        chargedPoints,
        pointsAfter: Number(clienteAfter.puntos || 0),
        tokensAfter: Number(clienteAfter.ruletaTokens || 0)
      });
    });

    session.endSession();
  } catch (e) {
    console.error('SPIN_ERROR', e);
    if (e.message === 'NO_TOKEN_AVAILABLE') return res.status(409).json({ ok: false, msg: 'Sin token disponible al momento de girar' });
    if (e.message === 'NO_BALANCE') return res.status(409).json({ ok: false, msg: 'Saldo insuficiente para cobrar el giro' });
    return res.status(500).json({ ok: false, msg: 'Error al girar', error: e?.message || String(e) });
  }
});




// === Conceder tokens (regalos) ===
router.put('/grant/:telefono', async (req, res) => {
  try {
    const t = req.params.telefono.replace(/\D/g, '').replace(/^52/, '').trim();
    const { tokens = 1 } = req.body;
    const cli = await Clientes.findOneAndUpdate(
      { telefono: { $regex: t + '$' } },
      { $inc: { ruletaTokens: Math.max(1, Number(tokens)) } },
      { new: true }
    );
    if (!cli) return res.status(404).json({ ok: false, msg: 'Cliente no encontrado' });
    res.json({ ok: true, cliente: cli });
  } catch (e) {
    console.error(e); res.status(500).json({ ok: false, msg: 'Error al otorgar tokens' });
  }
});

// === Marcar premio canjeado (cuando lo uses en un pedido) ===
function safeParseJSON(s) { try { return JSON.parse(s); } catch { return null; } }

router.post('/claim', async (req, res) => {
  try {
    const { telefono, spinId } = req.body;
    if (!telefono || !spinId) return res.status(400).json({ ok: false, msg: 'telefono y spinId requeridos' });

    const t = telefono.replace(/\D/g, '').replace(/^52/, '').trim();
    const cli = await Clientes.findOne({ telefono: { $regex: t + '$' } });
    if (!cli) return res.status(404).json({ ok: false, msg: 'Cliente no encontrado' });

    const arr = Array.isArray(cli.premiosPendientes) ? cli.premiosPendientes : [];
    let found = false;

    const newArr = arr.map(item => {
      const obj = (typeof item === 'string') ? safeParseJSON(item) : item;
      if (!obj) return item; // deja como estaba si no se puede parsear

      if (String(obj.spinId) === String(spinId)) {
        if (obj.redeemed) return item;
        obj.redeemed = true;
        found = true;
        // Guarda respetando el tipo original (string u objeto)
        return (typeof item === 'string') ? JSON.stringify(obj) : obj;
      }
      return item;
    });

    if (!found) return res.status(404).json({ ok: false, msg: 'Premio no encontrado' });

    cli.premiosPendientes = newArr;
    await cli.save();

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: 'Error al canjear premio' });
  }
});

module.exports = router;
