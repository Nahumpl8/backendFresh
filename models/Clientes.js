const mongoose = require('mongoose');

const ClientesSchema = new mongoose.Schema({
    nombre: { type: String, required: true },
    direccion: { type: String, required: true },
    telefono: { type: String, required: true },
    email: {
        type: String,
        default: null,
        lowercase: true, // Normalizar a minúsculas
        trim: true,
        validate: {
            validator: function (v) {
                // Si no hay email, está bien (es opcional)
                if (!v) return true;
                // Si hay email, validar formato
                return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
            },
            message: 'Email inválido'
        }
    },
    pin: { type: String }, // Aquí guardaremos el hash, no el numero directo
    sellos: { type: Number, default: 0 }, // Tu nueva variable para wallets
    misDirecciones: [{
        alias: String,
        direccion: String,
        gpsLink: String
    }],
    vendedor: { 
        type: String, 
        default: 'Fresh Market' // Por defecto es la tienda
    },
    telefonoSecundario: { type: String, default: null },
    gpsLink: { type: String },
    pedidos: { type: Array },
    totalPedidos: { type: Number },
    totalGastado: { type: Number },
    hasWallet: { type: Boolean, default: false },
    walletPlatform: { type: String, enum: ['none', 'apple', 'google', 'both'], default: 'none' },
    puntos: { type: Number, default: 0 },
    semanasSeguidas: { type: Number, default: 0 },
    regaloDisponible: { type: Boolean, default: false },
    ultimaSemanaRegistrada: { type: String },
    ultimaFechaPuntos: {
        type: Date,
        default: Date.now
    },
    ruletaTokens: { type: Number, default: 0 },
    premiosPendientes: [{
        source: { type: String, default: 'roulette' },
        key: String, label: String, type: String, value: Number,
        expiresAt: Date, redeemed: { type: Boolean, default: false },
        spinId: { type: mongoose.Schema.Types.ObjectId, ref: 'RouletteSpin' }
    }],
}, { timestamps: true });

// Índice único para email (solo aplica cuando email existe)
// sparse: true permite múltiples nulls
ClientesSchema.index({ email: 1 }, { unique: true, sparse: true });
// ---------------------------------------------------------
// 🚀 ÍNDICES DE VELOCIDAD (AGREGA ESTO)
// ---------------------------------------------------------
// Permite buscar rapidísimo por nombre y teléfono
ClientesSchema.index({ nombre: 1 });
ClientesSchema.index({ telefono: 1 });
// Índice de texto para el buscador "inteligente" (opcional pero recomendado)
ClientesSchema.index({ nombre: 'text', telefono: 'text' });

module.exports = mongoose.model('Clientes', ClientesSchema);
