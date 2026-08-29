const mongoose = require('mongoose');

// Ganadores del sorteo de la rifa de aniversario. Un solo documento por sorteo
// (clave `sorteo` única). El sorteo se hace y se persiste en el backend; el
// frontend solo revela a los ganadores ya decididos, uno por uno.
const RifaGanadorSchema = new mongoose.Schema({
    orden: { type: Number, required: true },                 // 1..16 (orden de revelado)
    premio: { type: String, enum: ['descuento', 'kit'], required: true },
    telefono: { type: String, required: true },              // completo, solo admin/backend
    nombre: { type: String, required: true },                // primer nombre capitalizado
    tel3: { type: String, required: true },                  // últimos 3 dígitos
    boletos: { type: Number, required: true },
}, { _id: false });

const RifaGanadoresSchema = new mongoose.Schema({
    sorteo: { type: String, required: true, unique: true },  // ej. 'aniversario-2026'
    ganadores: { type: [RifaGanadorSchema], default: [] },
    totalParticipantes: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('RifaGanadores', RifaGanadoresSchema);
