const mongoose = require('mongoose');

/**
 * Visita de reactivación: alguien del equipo pasó (camioneta) con un cliente
 * dormido o en peligro y anotó qué pasó. Sirve para medir si la visita lo
 * regresó: ver routes/reactivacion.js (/resumen).
 */
const VisitaSchema = new mongoose.Schema({
    telefono: { type: String, required: true, index: true },   // 10 dígitos
    nombre: String,
    colonia: { type: String, index: true },                     // clave normalizada de la colonia
    resultado: { type: String, enum: ['no_estaba', 'compro', 'pidio', 'no_interesa', 'otro'], required: true },
    monto: { type: Number, default: 0 },                        // lo que compró en ese momento
    nota: { type: String, default: '' },
    por: String,                                                // usuario admin que la registró
}, { timestamps: true });

module.exports = mongoose.model('Visita', VisitaSchema);
