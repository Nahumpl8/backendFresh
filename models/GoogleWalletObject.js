const mongoose = require('mongoose');

const GoogleWalletObjectSchema = new mongoose.Schema({
    objectId: { type: String, required: true, unique: true }, // ID persistente del objeto
    clienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Clientes', required: true },
    classId: { type: String, required: true }, // CLASS_NORMAL o CLASS_LEGEND
    state: { type: String, default: 'ACTIVE', enum: ['ACTIVE', 'COMPLETED', 'EXPIRED'] },
    version: { type: Number, default: 1 }, // Incrementar en cada actualización
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Índice para búsquedas rápidas por cliente
GoogleWalletObjectSchema.index({ clienteId: 1 });

module.exports = mongoose.model('GoogleWalletObject', GoogleWalletObjectSchema);

