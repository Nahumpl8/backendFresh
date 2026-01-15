const mongoose = require('mongoose');

const EmailCampaignSchema = new mongoose.Schema({
    subject: { type: String, required: true }, // Asunto: "¡Oferta de Martes!"
    body: { type: String, required: true },    // Mensaje: "Hola..."
    target: { type: String, default: 'all' },  // A quién: all, vip, lost
    recipientCount: { type: Number, default: 0 }, // Cuántos correos salieron
    sentAt: { type: Date, default: Date.now },    // Cuándo
    status: { type: String, default: 'sent' }     // sent, failed
}, { timestamps: true });

module.exports = mongoose.model('EmailCampaign', EmailCampaignSchema);