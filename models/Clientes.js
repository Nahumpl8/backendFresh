const mongoose = require('mongoose');

// 1. Definimos el Schema como "ClienteSchema" (Singular)
const ClienteSchema = new mongoose.Schema({
    // --- DATOS PERSONALES ---
    nombre: { type: String, required: true },
    direccion: { type: String, required: true },
    telefono: { type: String, required: true, unique: true },
    telefonoSecundario: { type: String, default: null },
    gpsLink: { type: String },
    
    // Auth (Opcionales)
    email: {
        type: String,
        default: null,
        lowercase: true,
        trim: true,
        sparse: true 
    },
    pin: { type: String },

    // Recuperación de PIN
    resetPinToken:   { type: String, default: null },
    resetPinExpires: { type: Date,   default: null },

    // Direcciones Extra
    misDirecciones: [{
        alias: String,
        direccion: String,
        gpsLink: String
    }],

    // --- 🟢 PROMOTORES ---
    vendedor: { 
        type: String, 
        default: 'Fresh Market' // Por defecto venta directa
    },

    // --- ESTADÍSTICAS GENERALES ---
    totalPedidos: { type: Number, default: 0 },
    totalGastado: { type: Number, default: 0 },

    // --- WALLET ---
    hasWallet: { type: Boolean, default: false },
    walletPlatform: { type: String, enum: ['none', 'apple', 'google', 'both'], default: 'none' },

    // --- PUNTOS (Cashback) ---
    puntos: { type: Number, default: 0 },

    // --- SISTEMA DE RACHA (Semanas seguidas) ---
    semanasSeguidas: { type: Number, default: 0 },
    ultimaSemanaRegistrada: { type: String }, // Ej: "2026-1"
    regaloDisponible: { type: Boolean, default: false }, // Regalo por racha de 4 semanas

    // --- 🟢 NUEVO: SISTEMA DE SELLOS INTELIGENTE ---
    sellos: { type: Number, default: 0 },              // Tarjeta actual (1-8). Se reinicia.
    sellosSemestrales: { type: Number, default: 0 },   // Acumulador histórico. NO se reinicia.
    ultimaSemanaSello: { type: String, default: '' },  // Freno semanal (Ej: "2026-1")
    tarjetasCompletadas: { type: Number, default: 0 }, // Histórico de tarjetas llenas
    premioDisponible: { type: Boolean, default: false }, // ¿Tiene derecho a premio por 8 sellos?

    // --- 🎡 RULETA (PREMIOS GANADOS) ---
    premiosPendientes: [{
        label: String,        
        type: String,         
        value: Number,        
        expiresAt: Date,      
        redeemed: { type: Boolean, default: false }, 
        redeemedAt: Date,
        spinId: { type: String } 
    }],

}, { timestamps: true });

// ---------------------------------------------------------
// 🚀 ÍNDICES DE VELOCIDAD
// ---------------------------------------------------------
// 2. Aquí usamos "ClienteSchema" (Singular) para coincidir con la definición de arriba
ClienteSchema.index({ email: 1 }, { unique: true, sparse: true });
ClienteSchema.index({ nombre: 1 });
ClienteSchema.index({ telefono: 1 });
ClienteSchema.index({ nombre: 'text', telefono: 'text' });

module.exports = mongoose.model('Clientes', ClienteSchema);