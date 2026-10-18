/**
 * Entorno de ejecución.
 *
 * `APP_ENTORNO` vale 'staging' en el environment de pruebas de Railway y no está
 * definida en producción (ausente = producción, para que nada cambie ahí).
 *
 * Esto NO es cosmético: staging comparte el código con producción, así que sin
 * estas guardas una prueba podría mandarle un correo a un cliente real, empujar
 * una notificación a su Wallet o gastar cuota de Anthropic. Las guardas viven en
 * los cuatro puntos donde el backend toca el mundo exterior, para que cualquier
 * ruta que los use quede cubierta sin tener que tocarla una por una:
 *
 *   utils/emailService.js   -> createTransport
 *   utils/pushApple.js      -> new apn.Provider
 *   routes/walletService.js -> new apn.Provider (notify-bulk crea el suyo)
 *   utils/pushGoogle.js     -> updateGoogleWalletObject
 *   utils/ai.js             -> new Anthropic
 */

// Se lee en CADA llamada, nunca al cargar el módulo. Si se capturara arriba,
// bastaría con que un `require` ocurriera antes de `dotenv.config()` para que
// `esStaging()` devolviera false con APP_ENTORNO=staging en el .env — y las
// guardas dejarían pasar correos, pushes y llamadas a Claude de verdad.
// Pasó de hecho con scripts/telegramPoll.js, que hace sus requires arriba.
const entorno = () => String(process.env.APP_ENTORNO || 'production').trim().toLowerCase();

const esStaging = () => entorno() === 'staging';
const esProduccion = () => !esStaging();

/**
 * Registra un efecto externo que se bloqueó por estar en staging.
 * Un log por intento: en pruebas conviene ver que el flujo llegó hasta aquí.
 */
function bloqueado(efecto, detalle = '') {
    console.log(`🧪 [staging] ${efecto} BLOQUEADO${detalle ? ': ' + detalle : ''}`);
}

module.exports = { entorno, esStaging, esProduccion, bloqueado };
