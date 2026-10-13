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
    vendedor: { type: String, required: false }, // ¿Quién cerró esta venta?
    comision: { type: Number, default: 0 },      // ¿Cuánto ganó? ($20 o $10)
    esClienteNuevo: { type: Boolean, default: false },
    puntosUsados: {
        type: Number,
        default: 0
    },
    regaloRuleta: { type: String, default: "" },        // ej. "1kg de Limón de regalo"
    regaloRuletaSpinId: { type: String, default: "" },
    regaloPromo: { type: String, default: "" },         // regalo por promoción (separado del regalo normal)
    via: { type: String, default: "" },                 // 'web' si el pedido vino de freshmarket.mx

    // --- 📊 MEDICIÓN DE CRECIMIENTO ---
    // `via` solo distingue la tienda web; `fuente` es el canal de adquisición y
    // se usa en /api/metricas. Los pedidos anteriores a esta medición quedan en
    // 'desconocido' (el campo via no existía antes del 21 jul 2026).
    fuente: {
        type: String,
        enum: ['whatsapp', 'telegram', 'email', 'web', 'anuncio', 'desconocido'],
        default: 'desconocido'
    },
    utm: {
        source:   { type: String, default: null },
        medium:   { type: String, default: null },
        campaign: { type: String, default: null }
    },
},
    { timestamps: true }
);
    
// Índices de métricas: las agregaciones de /api/metricas filtran por createdAt y
// agrupan por telefono. El índice de createdAt ya existía (autocreado); este par
// cubre el join por cliente sin recorrer la colección entera.
PedidoSchema.index({ telefono: 1, createdAt: -1 });

//timestamp is used to store the time when the Pedido is created or updated
module.exports = mongoose.model('Pedido', PedidoSchema);