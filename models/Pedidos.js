const mongoose = require('mongoose');

const PedidoSchema = new mongoose.Schema({
    cliente: { type: String, required: true, unique: false },
    direccion: { type: String, required: true, unique: false },
    telefono: { type: String, required: true, unique: false },
    despensa: { type: String, required: true },
    despensaQuantity: { type: Number, required: true },
    deletedProducts: { type: Array, required: false },
    newProducts: { type: Array, required: false },
    total: { type: Number, required: true },
    fecha: { type: String, required: true },
    nota: { type: String, required: false },
    reposicion: { type: String, required: false },
    envio: { type: Number, required: false },
    regalo: { type: String, required: false },
    editarPdf: { type: Boolean, required: false },
    puntosUsados: {
        type: Number,
        default: 0
    },
    premioUsadoLabel: { type: String, default: '' },
    premioUsadoSpinId: { type: String, default: '' }, // si quieres, usa ObjectId con ref: 'RouletteSpin'
    premioUsadoType: { type: String, enum: ['discount', 'item', 'multiplier', 'none', ''], default: '' },
    premioUsadoValue: { type: Number, default: 0 },
    premioDescuentoAplicado: { type: Number, default: 0 },
    puntosDoble: { type: Boolean, default: false },
},
    { timestamps: true }
);

//timestamp is used to store the time when the Pedido is created or updated
module.exports = mongoose.model('Pedido', PedidoSchema);