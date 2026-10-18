/**
 * Tokens de un solo uso.
 *
 * Extraído de routes/clientesAuth.js, donde `hashCodigo` vivía como función
 * local del flujo de recuperación de PIN. Ahora lo usan dos sitios (recuperar
 * PIN y vincular Telegram) y duplicar el SHA-256 sería pedir que se
 * desincronicen.
 *
 * El patrón, que ya estaba probado en producción:
 *   1. generar el token y entregárselo al usuario
 *   2. guardar SOLO el hash y una caducidad en el documento del cliente
 *   3. al consumirlo, comparar hashes, verificar caducidad y limpiar los campos
 *
 * Guardar el hash y no el token importa: si alguien lee la base, no puede usar
 * los tokens pendientes.
 */

const crypto = require('crypto');

/** SHA-256 en hex. Idéntico al de clientesAuth.js para no romper nada. */
const hashCodigo = (codigo) =>
    crypto.createHash('sha256').update(String(codigo)).digest('hex');

/**
 * Token para el deep link de Telegram.
 *
 * 32 caracteres hexadecimales: cabe de sobra en los 64 que admite el parámetro
 * `start` y usa solo `0-9a-f`, dentro del juego permitido (A-Z, a-z, 0-9, _, -).
 * Nada de base64: sus `+`, `/` y `=` no son válidos ahí y el enlace fallaría.
 */
const generarTokenEnlace = () => crypto.randomBytes(16).toString('hex');

/** Código corto de 6 dígitos para dictar o teclear (flujo `/vincular`). */
const generarCodigoCorto = () => String(crypto.randomInt(100000, 1000000));

/** Comparación en tiempo constante, para no filtrar información por el tiempo. */
function compararSeguro(a, b) {
    const ba = Buffer.from(String(a ?? ''), 'utf8');
    const bb = Buffer.from(String(b ?? ''), 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

/** Fecha de caducidad a N minutos (15 por defecto, igual que el reset de PIN). */
const caducaEn = (minutos = 15) => new Date(Date.now() + minutos * 60000);

module.exports = { hashCodigo, generarTokenEnlace, generarCodigoCorto, compararSeguro, caducaEn };
