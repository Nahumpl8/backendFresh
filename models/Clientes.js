const mongoose = require('mongoose');

const ClientesSchema = new mongoose.Schema({
    nombre:{type:String, required:true, unique:false},
    direccion:{type:String, required:true, unique:false},
    telefono:{type:String, required:true, unique:false},
    gpsLink:{type:String, required:false},
    pedidos:{type:Array, required:false},
    totalPedidos:{type:Number, required:false},
    totalGastado:{type:Number, required:false},

}, {timestamps:true});

//timestamp is used to store the time when the user is created or updated
module.exports = mongoose.model('Clientes', ClientesSchema);