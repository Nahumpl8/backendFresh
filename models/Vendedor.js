const mongoose = require('mongoose');

const VendedorSchema = new mongoose.Schema({
    nombre: { 
        type: String, 
        required: true, 
        unique: true, // Para no tener dos "Juan Perez"
        trim: true 
    },
    telefono: { type: String, default: "" },
    activo: { 
        type: Boolean, 
        default: true 
    }, // Si Laura renuncia, la pones en false, pero no borras su historial
    fechaIngreso: { 
        type: Date, 
        default: Date.now 
    }
}, { timestamps: true });

module.exports = mongoose.model('Vendedor', VendedorSchema);