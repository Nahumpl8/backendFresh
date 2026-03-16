const mongoose = require('mongoose');

const DespensasSchema = new mongoose.Schema({
    name:{type: String, required:true, unique:true},
    img:{type: String, required:true},
    price:{type: Number, required:true},
    products:[{
        productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
        cantidad: { type: Number, required: true },
        unidad: { type: String, required: true }
    }],
    allowChanges:{type: Boolean, default:true},
    showInWeb:{type: Boolean, default:true}
    }, 
    {timestamps:true}
);

//timestamp is used to store the time when the Product is created or updated
module.exports = mongoose.model('Despensas', DespensasSchema);