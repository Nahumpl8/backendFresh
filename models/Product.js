const mongoose = require('mongoose');

const ProductSchema = new mongoose.Schema({
    title:{type: String, required:true, unique:true},
    nombreSinUnidades:{type: String, required:false},
    desc:{type: String, required:true},
    img:{type: String, required:false},
    categories:{type: Array},
    tags:{type: Array},
    price:{type: Number, required:true},
    minUnit:{type: Number, required:true},
    unit:{type: String, required:true},
    inStock:{type: Boolean, default:true},
    showInWeb:{type: Boolean, default:true},
    cost:{type: Number, required:false},
    proveedor:{type: String, required:false},
    // Descomposición de combos/promos para la lista de compras por proveedor.
    // Ej: "PROMO de 1 kg naranja y 1 piña" -> [{nombre:'Naranja',cantidad:1,unidad:'kg',proveedor:'Central'}, ...]
    // Se genera con IA la 1a vez y se cachea aquí para no volver a llamarla.
    componentes:{type: Array, required:false},
    },
    {timestamps:true}
);

//timestamp is used to store the time when the Product is created or updated
module.exports = mongoose.model('Product', ProductSchema);