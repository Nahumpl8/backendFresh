const mongoose = require('mongoose');

const ClientesSchema = new mongoose.Schema({
    nombre: { type: String, required: true },
    direccion: { type: String, required: true },
    telefono: { type: String, required: true },
    telefonoSecundario: { type: String, default: null },
    gpsLink: { type: String },
    pedidos: { type: Array },
    totalPedidos: { type: Number },
    totalGastado: { type: Number },
    puntos: { type: Number, default: 0 },
    semanasSeguidas: { type: Number, default: 0 },
    regaloDisponible: { type: Boolean, default: false },
    ultimaSemanaRegistrada: { type: String },
    ultimaFechaPuntos: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

module.exports = mongoose.model('Clientes', ClientesSchema);
