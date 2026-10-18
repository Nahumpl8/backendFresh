/**
 * Wrapper sobre la Bot API de Telegram.
 *
 * Sin librería de bot: axios ya está en el proyecto y solo hacen falta siete
 * métodos. Una librería traería polling, middlewares y manejo de escenas que no
 * se usan, más una dependencia que mantener.
 *
 * Todas las llamadas devuelven un resultado CLASIFICADO en vez de lanzar: quien
 * envía necesita distinguir "reintenta en 30 s" de "este chat está muerto, no
 * vuelvas a intentarlo nunca". Esa distinción es la que evita que el bot acabe
 * marcado como spam.
 */

const axios = require('axios');

const TIMEOUT_MS = 10000;

// El token se lee en CADA llamada, no al cargar el módulo. Si se capturara
// arriba, bastaría con que un `require` ocurriera antes de `dotenv.config()`
// para que quedara vacío para siempre — y el fallo aparecería como "falta el
// token" aunque estuviera en el .env.
const token = () => process.env.TELEGRAM_BOT_TOKEN || '';
const apiBase = () => (token() ? `https://api.telegram.org/bot${token()}` : null);

/** ¿Hay token configurado? Sin esto no se puede hablar con Telegram. */
const hayToken = () => Boolean(token());

/**
 * Escapa texto para `parse_mode: 'HTML'`.
 *
 * Se usa HTML y no MarkdownV2 a propósito: MarkdownV2 obliga a escapar 18
 * caracteres y revienta con 400 en nombres que llevan `.`, `-`, `(` o `!`, que
 * abundan en la base ("Juan Samperio- Río de la soledad"). HTML solo necesita
 * tres sustituciones y es imposible de romper por accidente.
 */
const escaparHTML = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Clasificación del resultado de un envío:
 *   ok          -> entregado
 *   reintentar  -> fallo temporal; `esperarSegundos` dice cuánto
 *   bloqueado   -> el usuario bloqueó al bot o la cuenta ya no existe. TERMINAL
 *   error       -> fallo permanente de nuestra parte (texto mal formado, etc.)
 */
function clasificarError(status, body) {
    const desc = String(body?.description || '').toLowerCase();

    if (status === 429) {
        const espera = body?.parameters?.retry_after;
        return { tipo: 'reintentar', esperarSegundos: (Number(espera) || 30) + 1, desc };
    }

    // Terminal: el chat ya no existe para nosotros. Reintentar aquí es
    // exactamente lo que Telegram penaliza, y además nunca va a funcionar.
    if (status === 403 || /blocked by the user|user is deactivated|bot was kicked|chat not found|user not found/.test(desc)) {
        return { tipo: 'bloqueado', desc };
    }

    // 5xx y problemas de red: culpa del otro lado, se puede reintentar.
    if (status >= 500 || status === 0) {
        return { tipo: 'reintentar', esperarSegundos: 30, desc: desc || 'error del servidor' };
    }

    // 400 y demás: algo de nuestro payload está mal. Reintentar no arregla nada.
    return { tipo: 'error', desc };
}

/**
 * Llamada cruda a un método de la Bot API.
 * `validateStatus` siempre true para que 429 y 403 lleguen como datos y no como
 * excepción: son respuestas esperables, no fallos del programa.
 */
async function llamar(metodo, payload = {}, timeoutMs = TIMEOUT_MS) {
    const base = apiBase();
    if (!base) return { ok: false, tipo: 'error', desc: 'TELEGRAM_BOT_TOKEN no configurado' };

    try {
        const r = await axios.post(`${base}/${metodo}`, payload, {
            timeout: timeoutMs,
            validateStatus: () => true,
        });
        if (r.data && r.data.ok) return { ok: true, resultado: r.data.result };
        return { ok: false, ...clasificarError(r.status, r.data) };
    } catch (e) {
        // Timeout, DNS, socket cerrado: temporal.
        return { ok: false, tipo: 'reintentar', esperarSegundos: 30, desc: e.message };
    }
}

// ---------------------------------------------------------------------------
// Métodos usados
// ---------------------------------------------------------------------------

/** Datos del bot. Sirve para comprobar que el token es válido. */
const getMe = () => llamar('getMe');

/**
 * Envía un mensaje de texto.
 * `disableNotification` para avisos no urgentes: llega sin sonido.
 */
const enviarMensaje = ({ chatId, texto, replyMarkup, parseMode = 'HTML', disableNotification = false, replyTo }) =>
    llamar('sendMessage', {
        chat_id: chatId,
        text: texto,
        parse_mode: parseMode,
        disable_notification: disableNotification,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(replyTo ? { reply_to_message_id: replyTo } : {}),
        link_preview_options: { is_disabled: true },
    });

/**
 * Envía una foto con pie de texto. El pie admite hasta 1024 caracteres
 * (frente a 4096 de un mensaje), así que quien lo use debe recortar.
 */
const enviarFoto = ({ chatId, foto, pie, replyMarkup, parseMode = 'HTML' }) =>
    llamar('sendPhoto', {
        chat_id: chatId,
        photo: foto,
        caption: pie,
        parse_mode: parseMode,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });

/**
 * Varias fotos en un solo bloque (álbum). Telegram admite de 2 a 10 y no deja
 * poner botones en un álbum: los botones van en un mensaje aparte.
 */
const enviarAlbum = ({ chatId, fotos, parseMode = 'HTML' }) =>
    llamar('sendMediaGroup', {
        chat_id: chatId,
        media: fotos.slice(0, 10).map((f) => ({
            type: 'photo', media: f.foto, ...(f.pie ? { caption: f.pie, parse_mode: parseMode } : {}),
        })),
    });

/**
 * Botón fijo junto a la caja de texto que abre la tienda dentro de Telegram
 * (Mini App). Es global para todos los chats del bot.
 */
const setBotonMenuTienda = (texto, url) =>
    llamar('setChatMenuButton', {
        menu_button: { type: 'web_app', text: texto, web_app: { url } },
    });

/**
 * Envía un documento (PDF). `documento` puede ser un Buffer (se sube) o un
 * file_id de Telegram (reenvío instantáneo de algo ya subido).
 * Devuelve el resultado normal más `fileId` del documento enviado.
 */
async function enviarDocumento({ chatId, documento, nombre = 'archivo.pdf', pie, replyMarkup }) {
    if (!Buffer.isBuffer(documento)) {
        const r = await llamar('sendDocument', {
            chat_id: chatId, document: documento, caption: pie, parse_mode: 'HTML',
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        return r.ok ? { ...r, fileId: r.resultado.document && r.resultado.document.file_id } : r;
    }
    const base = apiBase();
    if (!base) return { ok: false, tipo: 'error', desc: 'TELEGRAM_BOT_TOKEN no configurado' };
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (pie) { form.append('caption', pie); form.append('parse_mode', 'HTML'); }
    if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
    form.append('document', new Blob([documento], { type: 'application/pdf' }), nombre);
    try {
        const r = await axios.post(`${base}/sendDocument`, form, { timeout: 120000, validateStatus: () => true });
        if (r.data && r.data.ok) {
            return { ok: true, resultado: r.data.result, fileId: r.data.result.document && r.data.result.document.file_id };
        }
        return { ok: false, ...clasificarError(r.status, r.data) };
    } catch (e) {
        return { ok: false, tipo: 'reintentar', esperarSegundos: 30, desc: e.message };
    }
}

/** Confirma que se recibió el toque de un botón (quita el relojito del botón). */
const responderBoton = (callbackQueryId, texto) =>
    llamar('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(texto ? { text: texto } : {}) });

/**
 * Descarga un archivo que mandó el usuario (por ejemplo, la foto de su lista).
 * Devuelve { base64, mediaType } o null. Tope de 5 MB: una foto de una lista
 * escrita a mano pesa mucho menos, y así nadie nos hace descargar gigas.
 */
async function descargarArchivo(fileId, maxBytes = 5 * 1024 * 1024) {
    const info = await llamar('getFile', { file_id: fileId });
    if (!info.ok || !info.resultado.file_path) return null;
    if (info.resultado.file_size && info.resultado.file_size > maxBytes) return null;
    try {
        const r = await axios.get(`https://api.telegram.org/file/bot${token()}/${info.resultado.file_path}`, {
            responseType: 'arraybuffer', timeout: 20000, maxContentLength: maxBytes,
        });
        const ruta = info.resultado.file_path.toLowerCase();
        const mediaType = ruta.endsWith('.png') ? 'image/png' : ruta.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
        return { base64: Buffer.from(r.data).toString('base64'), mediaType };
    } catch (e) {
        console.error('⚠️ descargarArchivo:', e.message);
        return null;
    }
}

/** Marca "escribiendo…" mientras se prepara una respuesta lenta. */
const enviarAccion = (chatId, accion = 'typing') =>
    llamar('sendChatAction', { chat_id: chatId, action: accion });

/** Registra el webhook. Solo se usa en producción; en local se hace polling. */
const setWebhook = ({ url, secretToken, allowedUpdates }) =>
    llamar('setWebhook', {
        url,
        secret_token: secretToken,
        allowed_updates: allowedUpdates || ['message', 'callback_query', 'my_chat_member'],
        drop_pending_updates: false,
    });

/** Quita el webhook. Es la mitad del rollback: el bot deja de recibir nada. */
const deleteWebhook = (dropPending = false) =>
    llamar('deleteWebhook', { drop_pending_updates: dropPending });

/**
 * Estado del webhook. El mejor diagnóstico que da Telegram:
 * `pending_update_count` y `last_error_message` dicen si está roto y por qué.
 */
const getWebhookInfo = () => llamar('getWebhookInfo');

/** Menú de comandos que ve el usuario al pulsar "/". */
const setMyCommands = (comandos) =>
    llamar('setMyCommands', { commands: comandos });

/** Updates por polling. Solo para desarrollo local (ver scripts/telegramPoll.js). */
// Long polling: Telegram mantiene la petición abierta hasta `timeout` segundos.
// El timeout de axios tiene que ser MAYOR, o corta la espera antes de tiempo.
const getUpdates = ({ offset, timeout = 25, allowedUpdates }) =>
    llamar('getUpdates', {
        offset,
        timeout,
        allowed_updates: allowedUpdates || ['message', 'callback_query', 'my_chat_member'],
    }, (timeout + 10) * 1000);

// ---------------------------------------------------------------------------
// Teclados
// ---------------------------------------------------------------------------

/**
 * Teclado para pedir el teléfono con un toque.
 * Telegram devuelve un objeto Contact con `phone_number` y `user_id`.
 * ⚠️ Quien lo procese DEBE comprobar `contact.user_id === message.from.id`:
 * si no, cualquiera puede reenviar el contacto de otra persona y vincularse a
 * su ficha, viendo sus puntos y sus premios.
 */
const tecladoCompartirTelefono = (texto = '📲 Compartir mi teléfono') => ({
    keyboard: [[{ text: texto, request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
});

// ---------------------------------------------------------------------------
// Tienda dentro de Telegram (Mini App)
// ---------------------------------------------------------------------------

/**
 * URL de la tienda para abrir como Mini App.
 *
 * Lleva `utm_source=telegram`: la tienda guarda los utm_* al entrar
 * (src/utils/utm.js) y los manda con el pedido, que así nace con
 * `fuente: 'telegram'` y aparece en Métricas sin código nuevo.
 * Ojo: eso solo funciona cuando estén desplegados la captura de UTM en la
 * tienda y el campo `fuente` en el backend. Sin ellos, el pedido entra igual,
 * pero como un pedido web normal.
 *
 * Telegram exige HTTPS para las Mini Apps: no vale localhost.
 */
function urlTienda(campana = 'bot') {
    const base = (process.env.TELEGRAM_TIENDA_URL || 'https://freshmarket.mx').replace(/\/+$/, '');
    const qs = new URLSearchParams({ utm_source: 'telegram', utm_medium: 'bot', utm_campaign: campana });
    return `${base}/?${qs.toString()}`;
}

/** Teclado persistente con las opciones del menú. */
const tecladoMenu = () => ({
    keyboard: [
        [{ text: '🛒 Despensas' }, { text: '📄 Lista de precios' }, { text: '📦 Mi pedido' }],
        [{ text: '🎟️ Sellos y puntos' }, { text: '🌐 Pedido vía web', web_app: { url: urlTienda('menu') } }, { text: '❓ Ayuda' }],
    ],
    resize_keyboard: true,
});

/** Quita cualquier teclado personalizado. */
const quitarTeclado = () => ({ remove_keyboard: true });

module.exports = {
    hayToken, escaparHTML, clasificarError, llamar,
    getMe, enviarMensaje, enviarFoto, enviarAlbum, enviarAccion, setBotonMenuTienda, urlTienda,
    responderBoton, descargarArchivo, enviarDocumento,
    setWebhook, deleteWebhook, getWebhookInfo, setMyCommands, getUpdates,
    tecladoCompartirTelefono, tecladoMenu, quitarTeclado,
};
