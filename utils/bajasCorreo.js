/**
 * Bajas de correo: quien pide no recibir más correos de promociones ni encuestas.
 *
 * Se guardan por correo (no por ficha): un mismo correo puede estar en varias
 * fichas. Todos los envíos masivos consultan `correosDeBaja()` antes de mandar.
 *
 * El enlace de baja va firmado (HMAC) para que nadie pueda dar de baja a otro
 * cambiando el correo en la URL. Abrir el enlace NO da de baja: muestra un botón
 * que confirma (los antivirus de Outlook/Hotmail abren los enlaces solos).
 */
const crypto = require('crypto');
const mongoose = require('mongoose');

const BajaSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    origen: { type: String, default: 'enlace' },   // 'enlace' (el cliente) o 'panel'
    por: String,                                    // admin que la capturó
}, { timestamps: true });
const BajaCorreo = mongoose.models.BajaCorreo || mongoose.model('BajaCorreo', BajaSchema);

const API = 'https://backendfresh-production.up.railway.app/api';
const secreto = () => process.env.BAJA_SECRET || process.env.ADMIN_JWT_SEC || process.env.JWT_SEC || 'fresh-bajas';
const normal = (e) => String(e || '').trim().toLowerCase();
const firma = (email) => crypto.createHmac('sha256', secreto()).update(normal(email)).digest('base64url').slice(0, 22);
const firmaValida = (email, f) => {
    const a = Buffer.from(firma(email)), b = Buffer.from(String(f || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** URL de baja de un correo (para el pie y el encabezado List-Unsubscribe). */
const urlBaja = (email) => `${API}/marketing/baja?e=${encodeURIComponent(normal(email))}&f=${firma(email)}`;

async function correosDeBaja() {
    return new Set((await BajaCorreo.find({}, { email: 1 }).lean()).map((b) => b.email));
}

async function darDeBaja(email, origen = 'enlace', por) {
    const e = normal(email);
    await BajaCorreo.updateOne({ email: e }, { $setOnInsert: { email: e, origen, por } }, { upsert: true });
    console.log(`📭 Baja de correos (${origen}${por ? `, ${por}` : ''})`);
}
const reactivar = (email) => BajaCorreo.deleteOne({ email: normal(email) });
const listar = () => BajaCorreo.find().sort({ createdAt: -1 }).lean();

module.exports = { BajaCorreo, urlBaja, firmaValida, correosDeBaja, darDeBaja, reactivar, listar };
