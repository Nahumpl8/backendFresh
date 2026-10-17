/**
 * Alta (o renovación) de un admin del panel.
 *
 *   node scripts/crearAdmin.js "<Nombre>" <usuario> <celular>
 *
 * La contraseña temporal es el celular: solo abre la pantalla de primer acceso
 * (correo + contraseña nueva) y caduca en 24 h. Si el usuario ya existe, se le
 * vuelve a poner la temporal (sirve para "olvidé mi contraseña" sin correo).
 * Nunca imprime la contraseña.
 */
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const { hashPassword } = require('../utils/password');

(async () => {
    const [nombre, usuarioArg, celularArg] = process.argv.slice(2);
    const usuario = String(usuarioArg || '').toLowerCase().trim();
    const celular = String(celularArg || '').replace(/\D/g, '').slice(-10);
    if (!nombre || !/^[a-z0-9._-]{3,30}$/.test(usuario) || celular.length !== 10) {
        console.log('Uso: node scripts/crearAdmin.js "<Nombre>" <usuario> <celular de 10 dígitos>');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URL);
    console.log(`Base: ${mongoose.connection.db.databaseName}`);

    const datos = {
        nombre, usuario, telefono: celular,
        hash: hashPassword(celular), temporal: true,
        temporalExpira: new Date(Date.now() + 24 * 3600 * 1000), activo: true,
    };
    const antes = await Admin.findOne({ usuario });
    await Admin.updateOne({ usuario }, { $set: datos }, { upsert: true });
    console.log(`${antes ? '♻️  Renovado' : '✅ Creado'}: ${nombre} (${usuario}). Contraseña temporal: su celular, vale 24 h.`);
    await mongoose.disconnect();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
