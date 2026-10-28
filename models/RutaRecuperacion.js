const mongoose = require('mongoose');

/**
 * Ruta de recuperación: casas de clientes dormidos o perdidos que un repartidor
 * visita para dejar un volante con regalo. Una ruta = una colonia, un día, un
 * repartidor. Lo que marca en cada casa también queda en Visita (para medir).
 */
const CasaSchema = new mongoose.Schema({
    telefono: String,
    nombre: String,
    direccion: String,
    favorita: String,
    pedidos: Number,
    dias: Number,                 // días sin comprar al armar la ruta
    segmento: String,
    resultado: { type: String, enum: ['no_estaba', 'volante', 'quiere_pedir', 'no_interesa', null], default: null },
    nota: { type: String, default: '' },
    marcadoAt: Date,
}, { _id: false });

const RutaRecuperacionSchema = new mongoose.Schema({
    fechaReparto: { type: String, required: true, index: true },   // YYYY-MM-DD
    repartidorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Repartidor', index: true },
    repartidorNombre: String,
    colonia: String,
    casas: [CasaSchema],
    creadaPor: String,
}, { timestamps: true });

module.exports = mongoose.model('RutaRecuperacion', RutaRecuperacionSchema);
