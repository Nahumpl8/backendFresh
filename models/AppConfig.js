const mongoose = require('mongoose');

const AppConfigSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    fechas: [{ type: String }],
    regalos: [{
        nombre: { type: String, required: true },
        cantidad: { type: Number, required: true },
        unidad: { type: String, required: true },
        precio: { type: Number, default: 0 },
        tier: { type: Number, default: 1 }
    }],
    // Cuándo el admin marcó las despensas de la semana como LISTAS (para ocultar el aviso
    // "en preparación" de la tienda antes de tiempo). null = no marcadas.
    despensasListasAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('AppConfig', AppConfigSchema);
