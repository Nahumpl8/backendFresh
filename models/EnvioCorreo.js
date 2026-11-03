const mongoose = require('mongoose');

/**
 * Cola de correos masivos (correo de la semana y encuestas).
 *
 * Cada destinatario es un documento: así un reinicio del servidor no corta el
 * envío ni hace que alguien lo reciba dos veces, y se respeta el límite diario
 * del proveedor (ver utils/colaCorreo.js).
 */
const LoteSchema = new mongoose.Schema({
    tipo: { type: String, enum: ['semanal', 'encuesta'], required: true },
    asunto: String,
    html: String,            // plantilla con {{nombre}} y {{baja}} (correo de la semana)
    text: String,
    descripcion: String,     // ej. "Encuestas de entregas 2026-10-28 a 2026-11-01"
    creadoPor: String,
    total: { type: Number, default: 0 },
}, { timestamps: true });

const EnvioSchema = new mongoose.Schema({
    lote: { type: mongoose.Schema.Types.ObjectId, ref: 'LoteCorreo', required: true, index: true },
    tipo: { type: String, enum: ['semanal', 'encuesta'], required: true },
    to: { type: String, required: true },
    nombre: String,
    encuestaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Encuesta' },
    estado: { type: String, enum: ['pendiente', 'enviando', 'enviado', 'error'], default: 'pendiente', index: true },
    intentos: { type: Number, default: 0 },
    error: String,
    tomadoAt: Date,
    enviadoAt: { type: Date, index: true },
}, { timestamps: true });
EnvioSchema.index({ lote: 1, to: 1 }, { unique: true });
EnvioSchema.index({ estado: 1, createdAt: 1 });

module.exports = {
    LoteCorreo: mongoose.models.LoteCorreo || mongoose.model('LoteCorreo', LoteSchema),
    EnvioCorreo: mongoose.models.EnvioCorreo || mongoose.model('EnvioCorreo', EnvioSchema),
};
