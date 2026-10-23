const mongoose = require('mongoose');

const PedidoSchema = new mongoose.Schema(
    {
        raw: String,
        emoji: String,
        nombre: String,
        direccion: String,
        paquete: String,
        extras: String,
        total: { type: Number, default: 0 },
        cel: String,
        nota: String,
        regalo: String,
        reposicion: String,
        diaDetectado: String,

        pago: {
            type: String,
            enum: ['efectivo', 'tarjeta', 'transferencia', 'combinado', 'cancelado', null],
            default: null,
        },
        pagoDetalle: {
            efectivo: Number,
            tarjeta: Number,
            transferencia: Number,
        },
        descuento: { type: Number, default: null },
        notaRepartidor: { type: String, default: null },
    },
    { _id: true }
);

const RutaSchema = new mongoose.Schema(
    {
        fechaReparto: { type: String, required: true, index: true }, // YYYY-MM-DD
        diaSemana: String,
        repartidorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Repartidor', index: true },
        repartidorNombre: String,
        cambioInicial: { type: Number, default: 0 },
        pedidos: [PedidoSchema],
        estado: {
            type: String,
            enum: ['pendiente', 'en_curso', 'cerrada'],
            default: 'pendiente',
        },
        // Gastos del repartidor durante la ruta (gasolina, estacionamiento...):
        // salen del efectivo que entrega.
        gastos: [
            {
                concepto: String,
                monto: { type: Number, default: 0 },
                _id: false,
            },
        ],
        totales: {
            efectivo: { type: Number, default: 0 },
            tarjeta: { type: Number, default: 0 },
            transferencia: { type: Number, default: 0 },
            gastos: { type: Number, default: 0 },
            cancelados: [String],
        },
        cerradaAt: Date,
        // Primera cuenta que envió el repartidor (antes de cualquier corrección)
        // y la lista de correcciones, para que siempre se vea qué se reportó.
        cierreOriginal: { type: mongoose.Schema.Types.Mixed, default: null },
        correcciones: [
            {
                at: Date,
                por: String,
                cambios: [String],
                totalesAntes: mongoose.Schema.Types.Mixed,
                totalesDespues: mongoose.Schema.Types.Mixed,
                _id: false,
            },
        ],
    },
    { timestamps: true }
);

module.exports = mongoose.model('Ruta', RutaSchema);
