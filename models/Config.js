const mongoose = require('mongoose');

const ConfigSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true }, // Ej: "gps_message"
    value: { type: String, required: true },             // Ej: "¡Ven por tu regalo!"
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Config', ConfigSchema);