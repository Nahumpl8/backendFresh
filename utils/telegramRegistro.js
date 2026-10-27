/**
 * Alta de clientes nuevos desde Telegram.
 *
 * Cuando alguien comparte su teléfono y no tiene ficha, en vez de mandarlo a
 * WhatsApp se le registra aquí mismo, paso a paso:
 *
 *   nombre → código postal → colonia (botones) → calle y número → ubicación → confirmar
 *
 * Es un flujo guiado, sin IA: los datos de una ficha tienen que salir exactos,
 * y así no cuesta nada. La zona de envío sale de la tabla de colonias (la misma
 * que usa la tienda), así que el costo queda bien desde el primer pedido.
 *
 * El estado vive en `TelegramChat.registro` para sobrevivir a un reinicio.
 * El teléfono es el que Telegram verificó al compartir el contacto: nunca uno
 * escrito a mano.
 */

const Clientes = require('../models/Clientes');
const TelegramChat = require('../models/TelegramChat');
const ColoniaEnvio = require('../models/ColoniaEnvio');
const tg = require('./telegram');
const { normalizar, dinero, puebloDe, textoPueblo } = require('./telegramPedidos');

const E = tg.escaparHTML;
const CADUCA_H = 24;                 // un registro a medias se olvida al día
const MAX_COLONIAS = 40;

const OMITIR = 'Omitir por ahora';
const tecladoUbicacion = () => ({
    keyboard: [
        [{ text: '📍 Compartir mi ubicación', request_location: true }],
        [{ text: OMITIR }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
});

const textoEnvio = (c) => (c.costoEnvio > 0
    ? `${dinero(c.costoEnvio)}${c.gratisJueves ? ' (gratis los jueves 🚚)' : ''}`
    : 'gratis 🚚');

/** Link de Google Maps a partir de las coordenadas que manda Telegram. */
const linkMaps = (lat, lng) => `https://www.google.com/maps?q=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;

/** ¿El texto trae un link de Google Maps? Devuelve el link o null. */
function linkMapsEnTexto(texto) {
    const m = String(texto || '').match(/https?:\/\/(?:www\.)?(?:google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps)\S*/i);
    return m ? m[0].slice(0, 500) : null;
}

/** Nombre con al menos una letra y algo de longitud; capitalizado. */
function limpiarNombre(texto) {
    const t = String(texto || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (t.length < 3 || !/[a-záéíóúñ]/i.test(t) || /\d{3,}/.test(t)) return null;
    return t.replace(/(^|\s)(\S)/g, (_, s, c) => s + c.toUpperCase());
}

async function guardar(chat, registro) {
    chat.registro = registro;
    await TelegramChat.updateOne({ _id: chat._id }, { $set: { registro } });
}

/** ¿Este chat está a media alta? */
function enCurso(chat) {
    const r = chat.registro;
    if (!r || !r.paso) return false;
    return Date.now() - new Date(r.at).getTime() < CADUCA_H * 3600000;
}

/** Arranca el alta. Lo llama manejarContacto cuando el teléfono no tiene ficha. */
async function empezar(chat, telefono, { responder }) {
    await guardar(chat, { paso: 'nombre', telefono, at: new Date() });
    return responder(chat.chatId,
        '¡Hola! 👋 Aún no tienes cuenta en Fresh Market, te registro en un minuto.\n\n' +
        '¿Cómo te llamas? <i>(nombre y apellido)</i>',
        tg.quitarTeclado());
}

async function pedirCp(chat, responder) {
    return responder(chat.chatId,
        '¿Cuál es tu <b>código postal</b>? 📮\n\n<i>Si no lo sabes, escríbeme el nombre de tu colonia.</i>',
        tg.quitarTeclado());
}

/** Busca colonias por CP (5 dígitos) o por nombre, y las ofrece como botones. */
async function ofrecerColonias(chat, texto, responder) {
    const cp = texto.replace(/\D/g, '');
    let filas;
    if (/^\d{5}$/.test(cp) && texto.replace(/[\s\d]/g, '') === '') {
        filas = await ColoniaEnvio.find({ cp, activo: true }).sort({ colonia: 1 }).lean();
    } else {
        const n = normalizar(texto);
        if (n.length < 3) return pedirCp(chat, responder);
        filas = (await ColoniaEnvio.find({ activo: true }).sort({ colonia: 1 }).lean())
            .filter((c) => normalizar(c.colonia).includes(n));
    }

    if (!filas.length) {
        // Se guarda lo que escribió por si pide ayuda al equipo con el botón.
        await guardar(chat, { ...chat.registro, ultimaBusqueda: texto.slice(0, 100) });
        return responder(chat.chatId,
            'No encontré esa zona en nuestras rutas de entrega 😔\n\n' +
            'Si vives en Acayuca, Zapotlán, Tolcayuca o Tizayuca, escríbeme el nombre del pueblo.\n' +
            'Revisa el código postal o escribe el nombre de tu colonia. ' +
            'Si de verdad no aparece, le pregunto al equipo si llegamos 👇',
            { inline_keyboard: [[{ text: '🙋 No aparece, pregúntale al equipo', callback_data: 'reg:equipo' }]] });
    }
    if (filas.length > MAX_COLONIAS) {
        return responder(chat.chatId, `Hay ${filas.length} colonias con ese nombre 😅 Mejor mándame tu código postal.`);
    }

    const botones = filas.map((c) => ({
        text: filas.some((o) => o !== c && o.colonia === c.colonia) ? `${c.colonia} (${c.cp})` : c.colonia,
        callback_data: `reg:col:${c._id}`,
    }));
    const filasBotones = [];
    for (let i = 0; i < botones.length; i += 2) filasBotones.push(botones.slice(i, i + 2));
    filasBotones.push([{ text: '✏️ Otro código postal', callback_data: 'reg:cp' }]);

    await guardar(chat, { ...chat.registro, paso: 'colonia', at: new Date() });
    return responder(chat.chatId, '¿En qué colonia vives? 👇', { inline_keyboard: filasBotones });
}

async function pedirUbicacion(chat, responder) {
    return responder(chat.chatId,
        'Por último, comparte tu <b>ubicación</b> para que el repartidor llegue directo 📍\n\n' +
        'Toca el botón de abajo, o pégame tu link de Google Maps.\n' +
        '<i>Tip: si no estás en tu casa ahora, mejor pega el link o elige «Omitir».</i>',
        tecladoUbicacion());
}

async function mostrarResumen(chat, responder) {
    const r = chat.registro;
    await guardar(chat, { ...r, paso: 'confirmar', at: new Date() });
    return responder(chat.chatId,
        '¿Están bien tus datos? 👇\n\n' +
        `👤 ${E(r.nombre)}\n` +
        `🏠 ${E(r.calle)}\n` +
        (r.pueblo
            ? `📍 ${E(r.colonia)}\n🚚 Entrega: ${E(textoPueblo(puebloDe(r.colonia)))}, sin costo`
            : `📍 ${E(r.colonia)}, CP ${E(r.cp)}${r.municipio ? `, ${E(r.municipio)}` : ''}\n` +
              `🗺️ Ubicación: ${r.gps ? 'compartida ✅' : 'sin ubicación'}\n` +
              `🚚 Envío: ${textoEnvio(r)}`),
        { inline_keyboard: [[
            { text: '✅ Sí, registrarme', callback_data: 'reg:ok' },
            { text: '✏️ Corregir', callback_data: 'reg:rehacer' },
        ]] });
}

/** Mensaje de texto o ubicación mientras el alta está en curso. */
async function manejarMensaje(chat, msg, deps) {
    const { responder } = deps;
    const r = chat.registro;
    const texto = String(msg.text || '').trim();

    if (r.paso === 'nombre') {
        const nombre = limpiarNombre(texto);
        if (!nombre) return responder(chat.chatId, 'Escríbeme tu nombre y apellido, por favor 🙂');
        await guardar(chat, { ...r, nombre, paso: 'cp', at: new Date() });
        return pedirCp(chat, responder);
    }

    if (r.paso === 'cp' || r.paso === 'colonia') {
        if (!texto) return pedirCp(chat, responder);
        const pueblo = puebloDe(texto);
        if (pueblo) {
            // Pueblo: entrega en punto fijo los viernes; no hace falta ubicación.
            await guardar(chat, {
                ...r, paso: 'calle', at: new Date(), pueblo: pueblo.clave,
                colonia: pueblo.nombre, cp: '', municipio: pueblo.nombre, costoEnvio: 0, gratisJueves: false,
            });
            return responder(chat.chatId,
                `📍 <b>${E(pueblo.nombre)}</b>: entregamos los <b>${E(textoPueblo(pueblo))}</b>, sin costo de envío 🚚\n\n` +
                'Para tu ficha, escríbeme tu <b>calle y número</b> (o tu localidad).');
        }
        return ofrecerColonias(chat, texto, responder);
    }

    if (r.paso === 'calle') {
        if (texto.length < 6 || !/[a-záéíóúñ]/i.test(texto)) {
            return responder(chat.chatId, 'Escríbeme la calle y el número, por favor. Por ejemplo: <i>Av. Juárez 120, portón negro</i>');
        }
        if (r.pueblo) {
            chat.registro = { ...r, calle: texto.slice(0, 200), gps: '' };
            return mostrarResumen(chat, responder);
        }
        await guardar(chat, { ...r, calle: texto.slice(0, 200), paso: 'ubicacion', at: new Date() });
        return pedirUbicacion(chat, responder);
    }

    if (r.paso === 'ubicacion') {
        let gps = null;
        if (msg.location) gps = linkMaps(msg.location.latitude, msg.location.longitude);
        else if (linkMapsEnTexto(texto)) gps = linkMapsEnTexto(texto);
        else if (texto !== OMITIR) {
            return responder(chat.chatId,
                'Toca <b>«📍 Compartir mi ubicación»</b>, pégame un link de Google Maps o elige «Omitir por ahora».',
                tecladoUbicacion());
        }
        chat.registro = { ...r, gps: gps || '' };
        await responder(chat.chatId, gps ? '¡Ubicación guardada! 📍' : 'Va, sin ubicación 👍', tg.quitarTeclado());
        return mostrarResumen(chat, responder);
    }

    if (r.paso === 'confirmar') return mostrarResumen(chat, responder);
}

/** Botones del alta: `reg:col:<id>`, `reg:cp`, `reg:ok`, `reg:rehacer`. */
async function manejarBoton(chat, data, deps) {
    const { responder } = deps;
    if (!enCurso(chat)) {
        return responder(chat.chatId, 'Ese registro ya caducó. Toca /start para empezar otra vez.');
    }
    const r = chat.registro;

    if (data === 'reg:cp') {
        await guardar(chat, { ...r, paso: 'cp', at: new Date() });
        return pedirCp(chat, responder);
    }
    if (data === 'reg:rehacer') {
        await guardar(chat, { paso: 'nombre', telefono: r.telefono, at: new Date() });
        return responder(chat.chatId, 'Va, empecemos de nuevo. ¿Cómo te llamas?');
    }
    if (data.startsWith('reg:col:')) {
        if (r.paso !== 'colonia') return null;
        const c = await ColoniaEnvio.findOne({ _id: data.slice('reg:col:'.length), activo: true }).lean().catch(() => null);
        if (!c) return pedirCp(chat, responder);
        await guardar(chat, {
            ...r, paso: 'calle', at: new Date(),
            colonia: c.colonia, cp: c.cp, municipio: c.municipio || '',
            costoEnvio: Number(c.costoEnvio) || 0, gratisJueves: c.costoEnvio > 0 && c.gratisJueves === true,
        });
        return responder(chat.chatId,
            `📍 <b>${E(c.colonia)}</b> — envío ${textoEnvio(c)}\n\n` +
            'Ahora escríbeme tu <b>calle y número</b>, con alguna referencia para el repartidor.\n' +
            '<i>Ejemplo: Av. Juárez 120, casa blanca con portón negro</i>');
    }
    if (data === 'reg:equipo') {
        const avisado = deps.preguntarEquipo ? await deps.preguntarEquipo(chat, {
            nombre: r.nombre || '', telefono: r.telefono, motivo: 'registro-zona', unaVezCadaMin: 60,
            pregunta: `Se está registrando y no encuentra su zona. Escribió: «${r.ultimaBusqueda || '(sin dato)'}». ¿Le podemos entregar?`,
        }).catch(() => false) : false;
        return responder(chat.chatId, avisado
            ? 'Listo, ya le pregunté al equipo 🙌 Te escriben aquí mismo. Mientras, puedes probar con tu código postal.'
            : 'No pude avisar al equipo ahorita 😓 Prueba con tu código postal o inténtalo en un momento.');
    }
    if (data === 'reg:ok') {
        if (r.paso !== 'confirmar') return null;
        return crearFicha(chat, deps);
    }
}

async function crearFicha(chat, deps) {
    const { responder, vincularChat, bienvenida } = deps;
    const r = chat.registro;
    const direccion = [r.calle, r.colonia, r.cp && `CP ${r.cp}`, r.municipio !== r.colonia && r.municipio]
        .filter(Boolean).join(', ');
    const zona = { costoEnvio: r.costoEnvio || 0, gratisJueves: r.gratisJueves === true };
    const datos = {
        nombre: r.nombre,
        telefono: r.telefono,
        direccion,
        gpsLink: r.gps || '',
        colonia: r.colonia, cp: r.cp,
        ...zona,
        misDirecciones: [{
            alias: 'Dirección Principal', direccion, gpsLink: r.gps || '',
            colonia: r.colonia, cp: r.cp, ...zona,
        }],
    };

    let cliente;
    try {
        cliente = await new Clientes(datos).save();
        console.log(`🆕 Cliente dado de alta desde Telegram: ${cliente.nombre} (${cliente.telefono})`);
    } catch (err) {
        // Mientras se registraba, alguien le creó la ficha (un pedido por WhatsApp,
        // la tienda): se usa esa y no se duplica.
        if (err.code === 11000) cliente = await Clientes.findOne({ telefono: r.telefono });
        if (!cliente) {
            console.error('❌ Alta desde Telegram:', err.message);
            const avisado = deps.preguntarEquipo ? await deps.preguntarEquipo(chat, {
                nombre: r.nombre || '', telefono: r.telefono, motivo: 'registro-error', unaVezCadaMin: 60,
                pregunta: `No se pudo terminar su registro desde Telegram (${String(err.message).slice(0, 120)}). Colonia: ${r.colonia || '-'}; dirección: ${r.calle || '-'}. Denlo de alta a mano.`,
            }).catch(() => false) : false;
            return responder(chat.chatId, avisado
                ? 'Uy, no pude terminar tu registro 😓 Ya le avisé al equipo para que lo terminen y te escriben aquí mismo.'
                : 'Uy, no pude terminar tu registro 😓 Inténtalo en un momento.');
        }
    }

    await TelegramChat.updateOne({ _id: chat._id }, { $set: { registro: null } });
    chat.registro = null;
    await vincularChat(chat, cliente, 'registro');
    return responder(chat.chatId, bienvenida(cliente.nombre) +
        '\n\n¿Qué te gustaría pedir? Escríbeme o toca 🛒 Despensas.', tg.tecladoMenu());
}

async function cancelar(chat) {
    if (!chat.registro) return;
    await TelegramChat.updateOne({ _id: chat._id }, { $set: { registro: null } });
    chat.registro = null;
}

module.exports = {
    empezar, enCurso, manejarMensaje, manejarBoton, cancelar,
    // para tests
    limpiarNombre, linkMapsEnTexto, linkMaps,
};
