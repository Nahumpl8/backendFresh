const mongoose = require('mongoose');
const { inferEnvioPrincipal, inferEnvioDireccion } = require('../utils/envioZonas');

// 1. Definimos el Schema como "ClienteSchema" (Singular)
const ClienteSchema = new mongoose.Schema({
    // --- DATOS PERSONALES ---
    nombre: { type: String, required: true },
    direccion: { type: String, required: true },
    telefono: { type: String, required: true, unique: true },
    telefonoSecundario: { type: String, default: null },
    gpsLink: { type: String },

    // --- 🚚 ENVÍO (dirección principal) ---
    costoEnvio: { type: Number, default: 0 },          // Costo de envío de la dirección principal
    gratisJueves: { type: Boolean, default: false },   // Zona azul: gratis los jueves

    // --- 📍 DIRECCIÓN ESTRUCTURADA (solo clientes nuevos; los viejos quedan en texto libre) ---
    colonia: { type: String, default: '' },
    cp: { type: String, default: '' },

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
        gpsLink: String,
        colonia: { type: String, default: '' },
        cp: { type: String, default: '' },
        costoEnvio: { type: Number, default: 0 },        // Costo de envío de esta dirección
        gratisJueves: { type: Boolean, default: false }  // Zona azul: gratis los jueves
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

    // --- 📊 MEDICIÓN DE CRECIMIENTO ---
    // Canal por el que prefiere que le escribamos. Por defecto WhatsApp, que es
    // como opera el negocio hoy.
    canalPreferido: {
        type: String,
        enum: ['whatsapp', 'telegram', 'email'],
        default: 'whatsapp'
    },
    telegramId: { type: String, default: null },

    // Fecha del último pedido. La calcula scripts/backfillMetricas.js desde la
    // colección de pedidos (no hay referencia por id: el enlace es el teléfono).
    ultimaCompra: { type: Date, default: null },

    // Alta del cliente. Se rellena con createdAt donde falte; existe aparte
    // porque createdAt es la fecha del documento, no necesariamente la del alta
    // real en el negocio (las fichas migradas comparten createdAt de la carga).
    fechaAlta: { type: Date, default: null },

    // Segmento para campañas de reactivación. Lo calcula el mismo backfill:
    //   pre_registro_con_compras -> ficha anterior a nov 2025, sin pedidos en la
    //       BD pero con contadores > 0 (compró antes de que hubiera registro)
    //   pre_registro_sin_rastro  -> ficha anterior a nov 2025, sin pedidos ni contadores
    //   dormido                  -> tiene pedidos, pero ninguno en los últimos 60 días
    //   null                     -> el resto (cliente activo o ficha reciente)
    segmentoReactivacion: {
        type: String,
        enum: ['pre_registro_con_compras', 'pre_registro_sin_rastro', 'dormido', null],
        default: null
    },

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
// Métricas: listados de reactivación y "clientes activos" ordenan por estos campos.
ClienteSchema.index({ ultimaCompra: -1 });
ClienteSchema.index({ segmentoReactivacion: 1 });

// ---------------------------------------------------------
// 🚚 AUTO-ENVÍO al crear un cliente nuevo
// ---------------------------------------------------------
// Solo al CREAR (isNew) y solo si no se mandó un costoEnvio explícito, infiere el
// costo de envío por la colonia (nombre tras " - " + dirección). Nunca pisa valores
// manuales ni re-infiere en clientes existentes (los .save() de pedidos tienen isNew=false).
ClienteSchema.pre('save', function (next) {
    if (!this.isNew) return next();

    // Dirección principal
    if (!this.costoEnvio) {
        const zona = inferEnvioPrincipal({ nombre: this.nombre, direccion: this.direccion });
        if (zona) {
            this.costoEnvio = zona.costoEnvio;
            this.gratisJueves = zona.gratisJueves;
        }
    }

    // Direcciones extra que vengan al crear
    if (Array.isArray(this.misDirecciones)) {
        this.misDirecciones.forEach((addr) => {
            if (addr && !addr.costoEnvio) {
                const zona = inferEnvioDireccion({ alias: addr.alias, direccion: addr.direccion });
                if (zona) {
                    addr.costoEnvio = zona.costoEnvio;
                    addr.gratisJueves = zona.gratisJueves;
                }
            }
        });
    }

    next();
});

// 🔒 Nunca sale el PIN (cifrado reversible) ni los códigos de recuperación en una
// respuesta: `pin` se convierte en true/null, que es lo único que usa la tienda
// (AuthModal: ¿ya tiene PIN?). Afecta a res.json(doc); las consultas .lean() que
// devuelven fichas deben seleccionar campos sin pin.
const ocultarSecretos = (doc, ret) => {
    ret.pin = ret.pin ? true : null;
    delete ret.resetPinToken;
    delete ret.resetPinExpires;
    return ret;
};
ClienteSchema.set('toJSON', { transform: ocultarSecretos });

module.exports = mongoose.model('Clientes', ClienteSchema);