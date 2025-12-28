const mongoose = require('mongoose');

const MarketingCampaignSchema = new mongoose.Schema({
    title: { type: String, required: true },   // Título interno (ej. "Promo Lunes")
    message: { type: String, required: true }, // El mensaje que sale en el Wallet
    sentAt: { type: Date, default: Date.now },
    stats: {
        total: { type: Number, default: 0 },
        success: { type: Number, default: 0 },
        failed: { type: Number, default: 0 }
    },
    createdBy: { type: String } // Opcional
}, { timestamps: true });

module.exports = mongoose.model('MarketingCampaign', MarketingCampaignSchema);