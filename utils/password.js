/**
 * Contraseñas de los admins del panel.
 *
 * scrypt viene en Node: sin dependencias nuevas. Se guarda `sal:hash` en hex.
 * La comparación es en tiempo constante.
 */
const crypto = require('crypto');

const LARGO = 64;
const PARAMS = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
    const sal = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), sal, LARGO, PARAMS).toString('hex');
    return `${sal}:${hash}`;
}

function verificarPassword(password, guardado) {
    if (!guardado || !String(guardado).includes(':')) return false;
    const [sal, hash] = String(guardado).split(':');
    const esperado = Buffer.from(hash, 'hex');
    const calculado = crypto.scryptSync(String(password ?? ''), sal, esperado.length, PARAMS);
    return esperado.length === calculado.length && crypto.timingSafeEqual(esperado, calculado);
}

/** Mínimo 8 caracteres, con al menos una letra y un número. */
function passwordValida(password) {
    const p = String(password || '');
    return p.length >= 8 && /[a-zA-Z]/.test(p) && /\d/.test(p);
}

/** Código de 6 dígitos para recuperar la contraseña y su hash (no se guarda en claro). */
const generarCodigo = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const hashCodigo = (codigo) => crypto.createHash('sha256').update(String(codigo)).digest('hex');

module.exports = { hashPassword, verificarPassword, passwordValida, generarCodigo, hashCodigo };
