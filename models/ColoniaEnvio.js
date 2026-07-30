const mongoose = require('mongoose');

/**
 * Cobertura de envío por colonia (editable desde el admin panel).
 * Reemplaza los keywords hardcodeados de utils/envioZonas.js: el operador puede
 * poner/editar el costo, marcar gratis-jueves y activar/desactivar colonias.
 *
 * - costoEnvio 0 + activo=true  => "envío por confirmar" (se entrega, operador ajusta)
 * - activo=false                => no se entrega ahí (sin cobertura)
 * - colonia inexistente / CP fuera de la tabla => sin cobertura ("no aplica")
 */
const ColoniaEnvioSchema = new mongoose.Schema({
    cp: { type: String, default: '', index: true },
    colonia: { type: String, required: true },
    municipio: { type: String, default: '' },
    costoEnvio: { type: Number, default: 0 },
    gratisJueves: { type: Boolean, default: false },
    activo: { type: Boolean, default: true },
}, { timestamps: true });

// Evita duplicados de la misma colonia en el mismo CP.
ColoniaEnvioSchema.index({ cp: 1, colonia: 1 }, { unique: true });

module.exports = mongoose.model('ColoniaEnvio', ColoniaEnvioSchema);
