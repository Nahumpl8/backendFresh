const express = require('express');
const app = express();
const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');
const cors = require('cors');

// Configuración básica
dotenv.config();
app.use(cors());
app.options('*', cors());
app.use(express.json());

// Archivos estáticos
app.use('/public', express.static(path.join(__dirname, 'assets')));

// --- IMPORTACIÓN DE RUTAS ---
const userRoute = require('./routes/users');
const authRoute = require('./routes/auth');
const productRoute = require('./routes/product');
const cartRoute = require('./routes/cart');
const orderRoute = require('./routes/order');
const clientesRoute = require('./routes/clientes');
const pedidosRoute = require('./routes/pedidos');
const despensasRoute = require('./routes/despensas');
const rouletteRoutes = require('./routes/roulette');
const clientesAuthRoute = require('./routes/clientesAuth');
const marketingRoute = require('./routes/marketing');
const vendedoresRoute = require('./routes/vendedores');

// 🟢 Aquí unificamos todo: Apple + Google + Redirecciones en un solo servicio
const walletServiceRoute = require('./routes/walletService'); 
const emailMarketingRoute = require('./routes/emailMarketing');
const inventarioStockRoute = require('./routes/inventarioStock');
const appConfigRoute = require('./routes/appConfig');

// --- CONEXIÓN A MONGODB ---
mongoose.connect(process.env.MONGO_URL)
    .then(() => { console.log('Connected to MongoDB') })
    .catch((err) => { console.log('Error: ', err) });

// --- DEFINICIÓN DE ENDPOINTS ---
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
app.use('/api/clientes-auth', clientesAuthRoute);
app.use('/api/marketing', marketingRoute);
app.use('/api/vendedores', vendedoresRoute);
app.use('/api/wallet', walletServiceRoute);
app.use('/api/marketing', emailMarketingRoute);
app.use('/api/inventario-stock', inventarioStockRoute);
app.use('/api/app-config', appConfigRoute);


// --- SERVIDOR ---
app.listen(process.env.PORT || 3000, () => {
  console.log('Backend server is running on port 3000!');
});