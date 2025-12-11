const mongoose = require('mongoose');

const DespensasSchema = new mongoose.Schema({
    name:{type: String, required:true, unique:true},
    img:{type: String, required:true},
    price:{type: Number, required:true},
    products:{type: Array},
    allowChanges:{type: Boolean, default:true},
    }, 
    {timestamps:true}
);

//timestamp is used to store the time when the Product is created or updated
module.exports = mongoose.model('Despensas', DespensasSchema);