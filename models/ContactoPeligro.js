const mongoose = require('mongoose');

/**
 * Seguimiento de "Clientes en peligro": a quién se le escribió y qué dijo.
 * Por teléfono (10 dígitos), porque hay clientes con pedidos y sin ficha.
 */
const ESTADOS = ['contactado', 'no_contesto', 'recuperado'];

const ContactoPeligroSchema = new mongoose.Schema({
    telefono: { type: String, required: true, unique: true },
    estado: { type: String, enum: ESTADOS, required: true },
    nota: { type: String, default: '' },
    por: String,
    historial: [{ estado: String, nota: String, por: String, at: Date, _id: false }],
}, { timestamps: true });

module.exports = mongoose.model('ContactoPeligro', ContactoPeligroSchema);
module.exports.ESTADOS = ESTADOS;
