// En routes/marketing.js (nuevo archivo) o routes/wallet.js

// Modelo MarketingCampaign (models/MarketingCampaign.js)
const mongoose = require('mongoose');

const MarketingCampaignSchema = new mongoose.Schema({
  title: { type: String, required: true },
  message: { type: String, required: true },
  summary: {
    total: Number,
    success: Number,
    failed: Number
  },
  sentAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('MarketingCampaign', MarketingCampaignSchema);

// Endpoints (en routes/wallet.js o routes/marketing.js)
const MarketingCampaign = require('../models/MarketingCampaign');

// GET /api/marketing/history
router.get('/marketing/history', async (req, res) => {
  try {
    const campaigns = await MarketingCampaign.find()
      .sort({ sentAt: -1 })
      .limit(50);
    res.status(200).json(campaigns);
  } catch (err) {
    console.error('Error al obtener historial:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/marketing/send
router.post('/marketing/send', async (req, res) => {
  try {
    const { title, message, summary } = req.body;
    const campaign = await MarketingCampaign.create({
      title,
      message,
      summary,
      sentAt: new Date()
    });
    res.status(201).json(campaign);
  } catch (err) {
    console.error('Error al guardar campaña:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/marketing/location-text (opcional, para guardar texto de ubicación)
router.post('/marketing/location-text', async (req, res) => {
  try {
    // Aquí podrías guardar el texto en una configuración
    // Por ahora solo retornamos éxito
    res.status(200).json({ success: true, message: 'Texto de ubicación actualizado' });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});