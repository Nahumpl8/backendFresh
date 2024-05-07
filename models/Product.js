const mongoose = require('mongoose');

const ProductSchema = new mongoose.Schema({
    title:{type: String, required:true, unique:true},
    nombreSinUnidades:{type: String, required:false},
    desc:{type: String, required:true},
    img:{type: String, required:false},
    categories:{type: Array},
    price:{type: Number, required:true},
    minUnit:{type: Number, required:true},
    unit:{type: String, required:true},
    inStock:{type: Boolean, default:true},
    cost:{type: Number, required:false},
    }, 
    {timestamps:true}
);

//timestamp is used to store the time when the Product is created or updated
module.exports = mongoose.model('Product', ProductSchema);