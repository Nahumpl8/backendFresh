const mongoose = require('mongoose');

const RepartidorSchema = new mongoose.Schema(
    {
        nombre: { type: String, required: true },
        telefono: { type: String, required: true, unique: true },
        activo: { type: Boolean, default: true },

        // PIN de 4 dígitos para entrar a la app de repartidores (scrypt, como las
        // contraseñas de admin). Lo asigna un admin desde /admin/repartidores.
        pinHash: { type: String, default: null, select: false },
        // Sube cada vez que cambia el PIN o se desactiva: invalida las sesiones viejas.
        sesionVersion: { type: Number, default: 0 },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Repartidor', RepartidorSchema);
