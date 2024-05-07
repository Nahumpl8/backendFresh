const mongoose = require('mongoose');

const CartSchema = new mongoose.Schema(
    {
        userId: {type: String, required:true},
        products: [
            {
                productId: {
                    type: String
                },
                quantity: {
                    type: Number, 
                    default: 1
                },
            }
        ],

    }, 
    {timestamps:true}
);

//timestamp is used to store the time when the Cart is created or updated
module.exports = mongoose.model('Cart', CartSchema);