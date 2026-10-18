/**
 * Sesión de los repartidores (app gestion-repartidores).
 *
 * Token `{ role: 'repartidor', sub, telefono, v }` firmado con la clave de admin.
 * `v` es la versión de sesión del repartidor: al cambiarle el PIN o
 * desactivarlo sube, y los tokens viejos dejan de valer.
 */
const { verificarJwt } = require('./adminMiddleware');

const CACHE_MS = 60 * 1000;
const cache = new Map();

async function versionVigente(id) {
    const c = cache.get(id);
    if (c && Date.now() - c.at < CACHE_MS) return c.v;
    const Repartidor = require('../models/Repartidor');
    const r = await Repartidor.findById(id).select('activo sesionVersion').lean().catch(() => null);
    const v = r && r.activo !== false ? (r.sesionVersion || 0) : null;
    cache.set(id, { v, at: Date.now() });
    return v;
}
const olvidarRepartidor = (id) => cache.delete(String(id));

/** Payload del repartidor si el request trae un token válido y vigente; si no, null. */
async function leerRepartidor(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return null;
    const p = await verificarJwt(header.slice(7));
    if (!p || p.role !== 'repartidor' || !p.sub) return null;
    const v = await versionVigente(String(p.sub));
    return v !== null && v === (p.v || 0) ? p : null;
}

module.exports = { leerRepartidor, olvidarRepartidor };
