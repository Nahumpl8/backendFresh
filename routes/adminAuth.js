/**
 * Login de los admins del panel.
 *
 *   POST /api/admin/login            { usuario, password }  (o { password } heredado)
 *   POST /api/admin/primer-acceso    { email, nueva }        token de primer acceso
 *   POST /api/admin/cambiar-password { actual, nueva }       token de admin
 *   POST /api/admin/olvide           { usuario }             manda código al correo
 *   POST /api/admin/restablecer      { usuario, codigo, nueva }
 *   GET  /api/admin/yo                                       token de admin
 *
 * La contraseña temporal (el celular) solo devuelve un token de primer acceso
 * de 30 min, que no abre ninguna otra ruta: un celular se puede adivinar.
 */
const router = require('express').Router();
const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');
const { hashPassword, verificarPassword, passwordValida, generarCodigo, hashCodigo } = require('../utils/password');
const { requireAdmin, verificarJwt, olvidarAdmin, legacyActivo, secretoAdmin } = require('../utils/adminMiddleware');

const DURACION = '7d';
const MSG_PASSWORD = 'La contraseña debe tener al menos 8 caracteres, con letras y números.';

// ---------------------------------------------------------------------------
// Límite de intentos (en memoria: basta con una sola instancia en Railway)
// ---------------------------------------------------------------------------
const VENTANA_MS = 15 * 60 * 1000;
const fallos = new Map();
const ipDe = (req) => String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();

function bloqueado(claves, max) {
    const ahora = Date.now();
    return claves.some((k) => {
        const f = fallos.get(k);
        return f && ahora - f.desde < VENTANA_MS && f.n >= max;
    });
}
function registrarFallo(claves) {
    const ahora = Date.now();
    for (const k of claves) {
        const f = fallos.get(k);
        if (!f || ahora - f.desde >= VENTANA_MS) fallos.set(k, { n: 1, desde: ahora });
        else f.n++;
    }
}
const limpiarFallos = (claves) => claves.forEach((k) => fallos.delete(k));
const MAX_FALLOS = 5;

/**
 * La gente escribe lo que recuerda: usuario, correo o celular. Se acepta
 * cualquiera de los tres; la contraseña sigue siendo la misma.
 */
function buscarAdmin(identificador) {
    const t = String(identificador || '').toLowerCase().trim();
    const digitos = t.replace(/\D/g, '');
    const o = [{ usuario: t }];
    if (t.includes('@')) o.push({ email: t });
    if (digitos.length >= 10 && digitos.length === t.replace(/[\s()+-]/g, '').length) o.push({ telefono: digitos.slice(-10) });
    return Admin.findOne({ $or: o });
}

function tokenAdmin(a) {
    return jwt.sign({ role: 'fresh-admin', sub: String(a._id), usuario: a.usuario, nombre: a.nombre },
        secretoAdmin(), { expiresIn: DURACION });
}
const perfil = (a) => ({ nombre: a.nombre, usuario: a.usuario, email: a.email || null });

// ---------------------------------------------------------------------------

router.post('/login', async (req, res) => {
    const { usuario, password } = req.body || {};
    const ip = ipDe(req);
    const claves = [`ip:${ip}`, ...(usuario ? [`u:${String(usuario).toLowerCase().trim()}`] : [])];
    if (bloqueado(claves, MAX_FALLOS)) {
        return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
    }

    try {
        // Heredado: solo contraseña compartida (app de repartidores, rifa). Se apaga con ADMIN_LEGACY=off.
        if (!usuario) {
            if (legacyActivo() && password && process.env.ADMIN_PASSWORD && password === process.env.ADMIN_PASSWORD) {
                limpiarFallos(claves);
                console.log(`🔑 Login admin con contraseña compartida (ip ${ip})`);
                return res.json({ token: jwt.sign({ role: 'fresh-admin' }, secretoAdmin(), { expiresIn: '30d' }) });
            }
            registrarFallo(claves);
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        }

        const a = await buscarAdmin(usuario).select('+hash');
        if (!a || !a.activo || !verificarPassword(password, a.hash)) {
            registrarFallo(claves);
            console.log(`🔒 Login admin fallido: ${String(usuario).slice(0, 30)} (ip ${ip})`);
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        }
        limpiarFallos(claves);

        if (a.temporal) {
            if (a.temporalExpira && a.temporalExpira < new Date()) {
                return res.status(401).json({ error: 'Tu contraseña temporal caducó. Pide que te la renueven.' });
            }
            const token = jwt.sign({ role: 'fresh-admin-setup', sub: String(a._id) }, secretoAdmin(), { expiresIn: '30m' });
            return res.json({ primerAcceso: true, token, nombre: a.nombre });
        }

        a.ultimoAcceso = new Date();
        await a.save();
        console.log(`🔑 Login admin: ${a.usuario}`);
        res.json({ token: tokenAdmin(a), admin: perfil(a) });
    } catch (e) {
        console.error('❌ /admin/login:', e.message);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

/** Primer acceso: con el token temporal pone su correo y su contraseña definitiva. */
router.post('/primer-acceso', async (req, res) => {
    try {
        const header = req.headers.authorization || '';
        const p = header.startsWith('Bearer ') ? await verificarJwt(header.slice(7)) : null;
        if (!p || p.role !== 'fresh-admin-setup') return res.status(401).json({ error: 'Vuelve a iniciar sesión.' });

        const { email, nueva } = req.body || {};
        const correo = String(email || '').toLowerCase().trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ error: 'Escribe un correo válido.' });
        if (!passwordValida(nueva)) return res.status(400).json({ error: MSG_PASSWORD });

        const a = await Admin.findById(p.sub).select('+hash');
        if (!a || !a.activo || !a.temporal) return res.status(401).json({ error: 'Vuelve a iniciar sesión.' });
        if (verificarPassword(nueva, a.hash)) return res.status(400).json({ error: 'La contraseña nueva no puede ser tu celular.' });

        a.email = correo;
        a.hash = hashPassword(nueva);
        a.temporal = false;
        a.temporalExpira = null;
        a.ultimoAcceso = new Date();
        await a.save();
        olvidarAdmin(a._id);
        console.log(`✅ Primer acceso completado: ${a.usuario}`);
        res.json({ token: tokenAdmin(a), admin: perfil(a) });
    } catch (e) {
        console.error('❌ /admin/primer-acceso:', e.message);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

router.post('/cambiar-password', requireAdmin, async (req, res) => {
    try {
        if (!req.admin.sub) return res.status(400).json({ error: 'Entra con tu usuario para cambiar tu contraseña.' });
        const { actual, nueva } = req.body || {};
        if (!passwordValida(nueva)) return res.status(400).json({ error: MSG_PASSWORD });
        const a = await Admin.findById(req.admin.sub).select('+hash');
        if (!a || !verificarPassword(actual, a.hash)) return res.status(401).json({ error: 'La contraseña actual no es correcta.' });
        a.hash = hashPassword(nueva);
        await a.save();
        console.log(`🔑 Contraseña cambiada: ${a.usuario}`);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Error del servidor' });
    }
});

/** Manda un código de 6 dígitos al correo. Responde igual exista o no el usuario. */
router.post('/olvide', async (req, res) => {
    const respuesta = { ok: true, mensaje: 'Si el usuario existe y tiene correo, te mandamos un código.' };
    try {
        const usuario = String((req.body || {}).usuario || '').toLowerCase().trim();
        const claves = [`olv:${ipDe(req)}`, `olvu:${usuario}`];
        if (bloqueado(claves, 3)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
        registrarFallo(claves);   // cuenta cada solicitud: máximo 3 cada 15 min

        const a = await buscarAdmin(usuario);
        if (!a || !a.activo || !a.email || a.temporal) return res.json(respuesta);
        const codigo = generarCodigo();
        a.resetCodigo = hashCodigo(codigo);
        a.resetExpira = new Date(Date.now() + 15 * 60 * 1000);
        a.resetIntentos = 0;
        await a.save();
        await require('../utils/emailService').sendAdminResetEmail(a.email, a.nombre, codigo);
        console.log(`📧 Código de recuperación enviado: ${a.usuario}`);
        res.json(respuesta);
    } catch (e) {
        console.error('❌ /admin/olvide:', e.message);
        res.json(respuesta);
    }
});

router.post('/restablecer', async (req, res) => {
    try {
        const { usuario, codigo, nueva } = req.body || {};
        if (!passwordValida(nueva)) return res.status(400).json({ error: MSG_PASSWORD });
        const a = await buscarAdmin(usuario).select('+resetCodigo');
        const invalido = () => res.status(400).json({ error: 'Código incorrecto o caducado.' });
        if (!a || !a.activo || !a.resetCodigo || !a.resetExpira || a.resetExpira < new Date()) return invalido();
        if (a.resetIntentos >= 5) return invalido();
        if (hashCodigo(String(codigo || '').trim()) !== a.resetCodigo) {
            a.resetIntentos += 1;
            await a.save();
            return invalido();
        }
        a.hash = hashPassword(nueva);
        a.resetCodigo = null;
        a.resetExpira = null;
        a.resetIntentos = 0;
        a.ultimoAcceso = new Date();
        await a.save();
        console.log(`🔑 Contraseña restablecida por correo: ${a.usuario}`);
        res.json({ token: tokenAdmin(a), admin: perfil(a) });
    } catch (e) {
        res.status(500).json({ error: 'Error del servidor' });
    }
});

router.get('/yo', requireAdmin, async (req, res) => {
    if (!req.admin.sub) return res.json({ nombre: 'Contraseña compartida', usuario: 'compartida', email: null });
    const a = await Admin.findById(req.admin.sub).lean();
    res.json(a ? perfil(a) : {});
});

module.exports = router;
