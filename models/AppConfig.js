const mongoose = require('mongoose');

const AppConfigSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    fechas: [{ type: String }],
    regalos: [{
        nombre: { type: String, required: true },
        cantidad: { type: Number, required: true },
        unidad: { type: String, required: true },
        precio: { type: Number, default: 0 }
    }]
}, { timestamps: true });

module.exports = mongoose.model('AppConfig', AppConfigSchema);
