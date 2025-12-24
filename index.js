const express = require('express');
const app = express();
const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');
app.use('/public', express.static(path.join(__dirname, 'assets')));
const userRoute = require('./routes/users');
const authRoute = require('./routes/auth');
const productRoute = require('./routes/product');
const cartRoute = require('./routes/cart');
const orderRoute = require('./routes/order');
const clientesRoute = require('./routes/clientes');
const pedidosRoute = require('./routes/pedidos');
const despensasRoute = require('./routes/despensas');
const rouletteRoutes = require('./routes/roulette');
const walletRoute = require('./routes/wallet');



const cors = require('cors');
app.use(cors());
dotenv.config();
app.options('*', cors());


// Connect to MongoDB
mongoose.connect(
    process.env.MONGO_URL
    ).then(()=>{console.log('Connected to MongoDB')})
    .catch((err)=>{   console.log('Error: ', err)});

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Welcome to the backend server!');
});



app.use("/api/auth", authRoute);
app.use("/api/users", userRoute);
app.use("/api/products", productRoute);
app.use("/api/carts", cartRoute);
app.use("/api/orders", orderRoute);
app.use("/api/clientes", clientesRoute);
app.use("/api/pedidos", pedidosRoute);
app.use("/api/despensas", despensasRoute);
app.use('/api/roulette', rouletteRoutes);
app.use('/api/wallet', walletRoute);



app.listen(process.env.PORT || 3000, () => {
  console.log('Backend server is running on port 3000!');
});