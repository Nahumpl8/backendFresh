const mongoose = require('mongoose');

/**
 * Encuesta de satisfacción de UNA entrega (todos los pedidos de un cliente el
 * mismo día). Se manda por correo al día siguiente con un enlace único (token):
 * así sabemos quién contesta y qué llevó sin pedirle datos.
 *
 * Al contestar gana un regalo que se agrega solo a su siguiente pedido
 * (ver reclamarRegalo en utils/encuestas.js).
 */
const EncuestaSchema = new mongoose.Schema({
    token: { type: String, required: true, unique: true },
    telefono: { type: String, required: true, index: true },   // últimos 10 dígitos
    nombre: String,
    email: String,
    fechaEntrega: String,          // como en Pedido.fecha: "sábado, 31 Octubre 2026"
    entregaISO: String,            // YYYY-MM-DD
    pedidos: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Pedido' }],
    repartidor: String,            // de la ruta de ese día, si se encontró
    categorias: [String],          // claves de CATEGORIAS que llevó
    productos: [{ nombre: String, categoria: String, _id: false }],
    version: Number,               // versión de las preguntas al enviarla
    origen: { type: String, default: 'auto' },   // 'auto' (día siguiente) o 'campana'
    envio: { at: Date, ok: Boolean, error: String },

    respondidaAt: Date,
    respuestas: { type: mongoose.Schema.Types.Mixed, default: null },
    mala: { type: Boolean, default: false, index: true },
    motivosMala: [String],
    seguimiento: {
        estado: { type: String, enum: ['pendiente', 'atendida', null], default: null },
        nota: String,
        por: String,
        at: Date,
    },

    regalo: {
        texto: String,
        estado: { type: String, enum: ['pendiente', 'aplicado', null], default: null },
        venceAt: Date,
        aplicadoAt: Date,
        pedidoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pedido' },
    },
}, { timestamps: true });

EncuestaSchema.index({ telefono: 1, entregaISO: 1 }, { unique: true });
EncuestaSchema.index({ 'regalo.estado': 1, telefono: 1 });
EncuestaSchema.index({ respondidaAt: -1 });

module.exports = mongoose.model('Encuesta', EncuestaSchema);
