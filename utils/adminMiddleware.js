const jwt = require('jsonwebtoken');

/**
 * Autenticación de los admins del panel.
 *
 * Dos tipos de token con `role: 'fresh-admin'`:
 *   - de usuario (`sub` = id del Admin): el normal desde oct 2026. Se comprueba
 *     que el usuario siga activo, así darlo de baja corta su acceso al instante.
 *   - heredado (sin `sub`): el de la contraseña compartida ADMIN_PASSWORD. Vale
 *     mientras ADMIN_LEGACY no sea 'off' — la transición hasta que el panel, la
 *     app de repartidores y la página de la rifa usen usuarios.
 *
 * El token de primer acceso (`role: 'fresh-admin-setup'`) NO pasa por aquí: solo
 * sirve para poner correo y contraseña nueva.
 */

const legacyActivo = () => String(process.env.ADMIN_LEGACY || '').toLowerCase() !== 'off';

// Caché corta del estado activo: evita una consulta por petición.
const CACHE_MS = 60 * 1000;
const cacheActivo = new Map();

async function adminActivo(id) {
    const c = cacheActivo.get(id);
    if (c && Date.now() - c.at < CACHE_MS) return c.activo;
    const Admin = require('../models/Admin');
    const a = await Admin.findById(id).select('activo temporal').lean().catch(() => null);
    const activo = Boolean(a && a.activo && !a.temporal);
    cacheActivo.set(id, { activo, at: Date.now() });
    return activo;
}
const olvidarAdmin = (id) => cacheActivo.delete(String(id));

function verificarJwt(token) {
    return new Promise((ok) => {
        jwt.verify(token, process.env.JWT_SEC, (err, payload) => ok(err ? null : payload));
    });
}

/** Devuelve el payload del admin si el request trae un token válido; si no, null. */
async function leerAdmin(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return null;
    const payload = await verificarJwt(header.slice(7));
    if (!payload || payload.role !== 'fresh-admin') return null;
    if (!payload.sub) return legacyActivo() ? { ...payload, usuario: 'compartida' } : null;
    return (await adminActivo(String(payload.sub))) ? payload : null;
}

const requireAdmin = async (req, res, next) => {
    try {
        const admin = await leerAdmin(req);
        if (!admin) return res.status(401).json({ error: 'No autorizado' });
        req.admin = admin;
        next();
    } catch (e) {
        res.status(401).json({ error: 'No autorizado' });
    }
};

module.exports = { requireAdmin, leerAdmin, verificarJwt, olvidarAdmin, legacyActivo };
