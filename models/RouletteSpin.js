const mongoose = require('mongoose');

const RouletteSpinSchema = new mongoose.Schema({
  telefono: { type: String, index: true, required: true },
  prizeKey: { type: String, required: true },
  prizeLabel: { type: String, required: true },
  prizeType: { type: String, enum: ['discount','item','multiplier','shipping','none'], required: true },
  prizeValue: { type: Number, default: 0 },
  usedToken: { type: Boolean, default: false },
  pointsAtSpin: { type: Number, default: 0 },
  eligibility: { type: String }, // 'rule' | 'token' | 'none'
  createdAt: { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model('RouletteSpin', RouletteSpinSchema);