const mongoose = require('mongoose');

/**
 * Usuarios del panel de administración (uno por persona).
 *
 * Sustituye a la contraseña compartida ADMIN_PASSWORD: así se sabe quién hizo
 * qué y se puede dar de baja a alguien sin cambiarle la contraseña a nadie más.
 *
 * Alta: scripts/crearAdmin.js. La primera contraseña es temporal (su celular):
 * solo abre la pantalla de primer acceso y caduca (ver routes/adminAuth.js).
 */
const AdminSchema = new mongoose.Schema({
    nombre: { type: String, required: true, trim: true },
    usuario: { type: String, required: true, unique: true, lowercase: true, trim: true },
    telefono: { type: String, default: '' },
    email: { type: String, default: null, lowercase: true, trim: true },

    hash: { type: String, required: true, select: false },
    temporal: { type: Boolean, default: true },          // debe cambiarla al entrar
    temporalExpira: { type: Date, default: null },

    // Recuperación por correo
    resetCodigo: { type: String, default: null, select: false },   // sha256 del código
    resetExpira: { type: Date, default: null },
    resetIntentos: { type: Number, default: 0 },

    activo: { type: Boolean, default: true },
    ultimoAcceso: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('Admin', AdminSchema);
