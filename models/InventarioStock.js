const mongoose = require('mongoose');

const InventarioStockSchema = new mongoose.Schema({
    fecha: { type: String, required: true, unique: true },
    stock: { type: Map, of: Number, default: {} }
}, { timestamps: true });

module.exports = mongoose.model('InventarioStock', InventarioStockSchema);
