const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username:{type:String, required:true, unique:false},
    email:{type:String, unique:true},
    password:{type:String, required:true, minlength:6},
    isAdmin:{
        type:Boolean,
        default:false
    },
}, {timestamps:true});

//timestamp is used to store the time when the user is created or updated
module.exports = mongoose.model('User', UserSchema);