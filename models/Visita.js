const mongoose = require('mongoose');

/**
 * Visita de recuperación: un repartidor pasó con un cliente dormido o perdido,
 * le dejó el volante con regalo y anotó qué pasó. Sirve para medir si la visita lo
 * regresó: ver routes/reactivacion.js (/resumen).
 */
const VisitaSchema = new mongoose.Schema({
    telefono: { type: String, required: true, index: true },   // 10 dígitos
    nombre: String,
    colonia: { type: String, index: true },                     // clave normalizada de la colonia
    resultado: { type: String, enum: ['no_estaba', 'volante', 'quiere_pedir', 'no_interesa'], required: true },
    nota: { type: String, default: '' },
    rutaId: { type: mongoose.Schema.Types.ObjectId, ref: 'RutaRecuperacion' },
    por: String,                                                // repartidor (o admin) que la registró
}, { timestamps: true });

module.exports = mongoose.model('Visita', VisitaSchema);
