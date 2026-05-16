const mongoose = require('mongoose');

const RepartidorSchema = new mongoose.Schema(
    {
        nombre: { type: String, required: true },
        telefono: { type: String, required: true, unique: true },
        activo: { type: Boolean, default: true },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Repartidor', RepartidorSchema);
