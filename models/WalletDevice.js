const mongoose = require('mongoose');

const WalletDeviceSchema = new mongoose.Schema({
    deviceLibraryIdentifier: { type: String, required: true }, // ID único del iPhone
    pushToken: { type: String, required: true }, // La "dirección" para enviar notificaciones
    passTypeIdentifier: { type: String, required: true }, // Tu ID de Apple (pass.com.freshmarket...)
    serialNumber: { type: String, required: true }, // El ID del pase (FRESH-XXXXX)
    createdAt: { type: Date, default: Date.now }
});

// Índice para búsquedas rápidas (Evita duplicados)
WalletDeviceSchema.index({ deviceLibraryIdentifier: 1, serialNumber: 1 }, { unique: true });

module.exports = mongoose.model('WalletDevice', WalletDeviceSchema);