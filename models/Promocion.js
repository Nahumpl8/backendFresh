const mongoose = require('mongoose');

const PromocionSchema = new mongoose.Schema({
    nombre: { type: String, required: true },              // etiqueta interna admin

    // Tipo de beneficio
    tipo: { type: String, enum: ['regalo', 'descuento', 'puntosDobles'], default: 'regalo' },
    regalo: { type: String, default: '' },                 // si tipo=regalo (ej. "1kg de Jitomate")
    descuento: { type: Number, default: 0 },               // si tipo=descuento (monto en $)

    // A qué pedidos aplica
    canal: { type: String, enum: ['web', 'manual', 'ambos'], default: 'ambos' },
    fechaEntrega: { type: String, default: '' },           // '' = cualquier fecha activa

    // Cupo / conteo
    contarPor: { type: String, enum: ['cliente', 'pedido'], default: 'cliente' },
    limite: { type: Number, default: 0 },                  // 0 = sin límite
    usados: { type: Number, default: 0 },
    telefonosReclamados: [{ type: String }],               // dedup cuando contarPor='cliente'

    activa: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Promocion', PromocionSchema);
