/**
 * Lógica del bot: qué hacer con cada update que llega de Telegram.
 *
 * Vive aparte de la ruta a propósito. En producción los updates entran por
 * webhook (routes/telegram.js) y en local por polling (scripts/telegramPoll.js);
 * los dos llaman a `procesarUpdate`, así que lo que se prueba en la Mac es
 * exactamente lo que corre en producción.
 */

const Clientes = require('../models/Clientes');
const TelegramChat = require('../models/TelegramChat');
const Config = require('../models/Config');
const Pedido = require('../models/Pedidos');
const Despensas = require('../models/Despensas');
require('../models/Product'); // lo necesita el populate de las despensas
const tg = require('./telegram');
const { hashCodigo, generarCodigoCorto, caducaEn } = require('./tokens');
const agente = require('./telegramAgente');
const lista = require('./telegramLista');
const registro = require('./telegramRegistro');
const { pedidosCerrados } = require('./telegramPedidos');
const AppConfig = require('../models/AppConfig');

/** ¿Pedidos cerrados ahora? Respeta el interruptor «despensas listas» del panel. */
async function estaCerrado() {
    // Solo para probar el cierre fuera de horario; ignorado en producción.
    if (require('./entorno').esStaging() && String(process.env.TELEGRAM_FORZAR_CIERRE) === 'true') return true;
    let listasAt = null;
    try { listasAt = ((await AppConfig.findOne({ key: 'main' }, 'despensasListasAt').lean()) || {}).despensasListasAt; } catch (e) {}
    return pedidosCerrados(new Date(), listasAt);
}

const Conversacion = require('../models/TelegramConversacion');
const HORAS_PEDIDO_TARDIO = 12;   // una cotización de hace más tiempo ya no se ofrece

/**
 * Pedido cotizado antes del cierre que el cliente quiere confirmar ya cerrado.
 * Devuelve la conversación si hay uno pendiente de decidir, o null.
 */
async function pedidoCasiListo(chatId) {
    const conv = await Conversacion.findOne({ chatId: String(chatId), estado: 'activa' }).sort({ updatedAt: -1 });
    if (!conv || !conv.cotizacion || !conv.cotizadaAt) return null;
    if (Date.now() - new Date(conv.cotizadaAt).getTime() > HORAS_PEDIDO_TARDIO * 3600000) return null;
    if (conv.solicitudTardia && conv.solicitudTardia.estado !== 'esperando') return null;
    return conv;
}

const MENSAJE_CERRADO =
    'Ya cerramos los pedidos de esta semana 🙏\n\n' +
    'Las nuevas despensas y la lista de precios estarán listas el <b>lunes después de las 11 am</b>. ¡Te esperamos!\n\n' +
    'Te mando aquí las despensas nuevas en cuanto estén listas 🔔\n\n' +
    'Mientras tanto puedes consultar tus sellos, tus puntos y tu último pedido en el menú.';

/**
 * Respuesta con pedidos cerrados. Apunta el chat para mandarle las despensas
 * nuevas en cuanto abran (ver revisarAperturas).
 */
async function responderCerrado(chat) {
    await TelegramChat.updateOne({ _id: chat._id }, { $set: { avisarApertura: new Date() } });
    return responder(chat.chatId, MENSAJE_CERRADO, tg.tecladoMenu());
}

const E = tg.escaparHTML;

// Mismo criterio que todo el repo: en Clientes conviven teléfonos con lada,
// espacios y guiones, así que se compara por los últimos 10 dígitos.
const limpiarTelefono = (t) => String(t || '').replace(/\D/g, '').slice(-10);

// ---------------------------------------------------------------------------
// Modo beta
// ---------------------------------------------------------------------------

/** 'beta' (solo la lista) o 'publico' (todos). Vive en Mongo para cambiarlo sin redeploy. */
async function obtenerModo() {
    try {
        const c = await Config.findOne({ key: 'telegram_modo' }).lean();
        return c && c.value === 'publico' ? 'publico' : 'beta';
    } catch (e) {
        // Ante la duda, el modo más restrictivo.
        console.error('⚠️ telegram_modo:', e.message);
        return 'beta';
    }
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

/** Crea o actualiza el TelegramChat con lo que venga del update. */
async function registrarChat(from, chat, extra = {}) {
    const chatId = String(chat.id);
    const datos = {
        userId: String(from.id),
        username: from.username || null,
        firstName: from.first_name || null,
        lastName: from.last_name || null,
        languageCode: from.language_code || null,
        ultimoInboundAt: new Date(),
        ...extra,
    };
    return TelegramChat.findOneAndUpdate(
        { chatId },
        { $set: datos, $setOnInsert: { chatId } },
        { upsert: true, new: true },
    );
}

/**
 * Vincula un chat con una ficha de cliente.
 *
 * ÚNICO sitio donde se escribe `Clientes.telegramId`. Los dos documentos se
 * tocan aquí y solo aquí para que no se desincronicen: el puntero en la ficha
 * existe para que el flujo de pedidos encole sin una segunda consulta.
 */
async function vincularChat(chat, cliente, metodo) {
    const ahora = new Date();

    // Si esta cuenta de Telegram estaba vinculada a OTRA ficha, se suelta la
    // anterior: una cuenta de Telegram pertenece a una sola persona.
    await Clientes.updateMany(
        { telegramId: chat.chatId, _id: { $ne: cliente._id } },
        { $set: { telegramId: null, telegramVinculadoAt: null } },
    );

    await Clientes.updateOne({ _id: cliente._id }, {
        $set: {
            telegramId: chat.chatId,
            telegramUsername: chat.username || null,
            telegramVinculadoAt: ahora,
            telegramLinkToken: null,      // el token es de un solo uso
            telegramLinkCodigo: null,
            telegramLinkExpires: null,
        },
    });

    await TelegramChat.updateOne({ _id: chat._id }, {
        $set: {
            clienteId: cliente._id,
            telefono: limpiarTelefono(cliente.telefono),
            vinculadoAt: ahora,
            metodoVinculacion: metodo,
            enEspera: false,
            bloqueado: false,
        },
    });

    console.log(`🔗 Telegram vinculado: chat ${chat.chatId} -> ${cliente.nombre} (${metodo})`);
    return cliente;
}

/** Busca la ficha por teléfono con el criterio de sufijo que usa todo el repo. */
async function buscarClientePorTelefono(telefono) {
    const t = limpiarTelefono(telefono);
    if (t.length !== 10) return null;
    return Clientes.findOne({ telefono: { $regex: t + '$' } });
}

// ---------------------------------------------------------------------------
// Envío
// ---------------------------------------------------------------------------

/**
 * Responde al chat. En el Paso 1 se envía directo; a partir del Paso 3 esto
 * pasará por la cola durable.
 */
async function responder(chatId, texto, replyMarkup) {
    // Un corte de red al enviar (ECONNRESET, timeout) dejaba al cliente sin
    // respuesta y con la sensación de que el bot se trabó. Se reintenta dos veces
    // con espera creciente; los errores definitivos (bloqueado, 400) no se reintentan.
    let r = await tg.enviarMensaje({ chatId, texto, replyMarkup });
    for (const espera of [1500, 4000]) {
        if (r.ok || r.tipo !== 'reintentar') break;
        await new Promise((ok) => setTimeout(ok, Math.max(espera, (r.esperarSegundos || 0) > 60 ? espera : (r.esperarSegundos || 0) * 1000)));
        r = await tg.enviarMensaje({ chatId, texto, replyMarkup });
    }
    if (r.ok) {
        await TelegramChat.updateOne(
            { chatId: String(chatId) },
            { $set: { ultimoOutboundAt: new Date() }, $inc: { mensajesEnviados: 1 } },
        ).catch(() => {});
    } else if (r.tipo === 'bloqueado') {
        await TelegramChat.updateOne(
            { chatId: String(chatId) },
            { $set: { bloqueado: true, bloqueadoAt: new Date(), optIn: false } },
        ).catch(() => {});
        console.log(`🚫 chat ${chatId} bloqueó al bot`);
    } else {
        console.error(`⚠️ envío a ${chatId} falló (${r.tipo}): ${r.desc}`);
    }
    return r;
}

// ---------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------

const TEXTOS = {
    esperaBeta:
        '¡Muy pronto! 🥬\n\n' +
        'Todavía estamos afinando este canal con un grupo pequeño. ' +
        'Te avisamos aquí mismo en cuanto esté listo para todos.',

    pedirTelefono:
        '¡Hola! 👋 Soy el bot de <b>Fresh Market</b>.\n\n' +
        'Comparte tu teléfono con el botón de abajo. Si ya compras con nosotros, ' +
        'te reconozco al instante; si eres nuevo, te registro en un minuto 🥬',

    yaVinculado: (nombre) =>
        `Ya estás conectado, ${E(nombre)} ✅\n\nUsa el menú de abajo para ver tus sellos y tus puntos.`,

    bienvenida: (nombre) =>
        `¡Listo, ${E(nombre)}! ✅\n\n` +
        'Tu cuenta de Fresh Market quedó conectada a Telegram.\n\n' +
        'Aquí te avisaremos de tus pedidos, tus sellos y tus premios. ' +
        'Usa el menú de abajo cuando quieras consultar algo.',

    noEncontrado:
        'No encontré una cuenta con ese teléfono 🤔\n\n' +
        'Puede que compres con otro número. Escríbenos y lo revisamos: ' +
        'https://wa.me/527712346620',

    tokenInvalido:
        'Ese enlace ya no es válido (caducan a los 15 minutos) ⏳\n\n' +
        'No pasa nada: comparte tu teléfono y te conecto igual.',

    telefonoEscrito:
        'Por seguridad no puedo usar un número escrito 🔒\n\n' +
        'Si lo aceptara, cualquiera podría teclear el teléfono de otra persona y ' +
        'quedarse con su cuenta. Pulsa el botón <b>«📲 Compartir mi teléfono»</b> ' +
        'de abajo: así Telegram confirma que el número es tuyo.\n\n' +
        '<i>¿No ves el botón? Toca el ícono de teclado junto a la caja de texto.</i>',

    contactoAjeno:
        'Ese contacto no es el tuyo 🤔\n\n' +
        'Por seguridad solo puedo conectar la cuenta de Telegram con su propio ' +
        'teléfono. Usa el botón de abajo para compartir el tuyo.',

    baja:
        'Listo, no te mandaré más promociones 👍\n\n' +
        'Seguirás recibiendo los avisos de <b>tus</b> pedidos y premios. ' +
        'Si quieres volver a las promos, escribe /promos.',

    altaPromos: '¡Bienvenido de vuelta! 🎉 Volverás a recibir nuestras promociones.',

    ayuda:
        '<b>¿Qué puedo hacer?</b>\n\n' +
        '💬 <b>Escríbeme lo que quieres</b> — tomo tu pedido aquí mismo, o mándame una foto de tu lista\n' +
        '🌐 <b>Pedido vía web</b> — abre la tienda aquí mismo\n' +
        '🛒 /despensas — ver despensas y precios\n' +
        '📄 /lista — lista de precios en PDF\n' +
        '🎟️ <b>Sellos y puntos</b> — tu tarjeta y tus puntos (/missellos, /mispuntos)\n' +
        '📦 /mipedido — tu último pedido\n' +
        '🔄 /cancelar — empezar un pedido de cero\n' +
        '🔕 /baja — dejar de recibir promociones\n\n' +
        'Para cualquier duda, escríbenos por WhatsApp: ' +
        'https://wa.me/527712346620',
};

// ---------------------------------------------------------------------------
// Manejadores
// ---------------------------------------------------------------------------

/** /start, con o sin token de deep link. */
async function manejarStart(chat, from, parametro) {
    const modo = await obtenerModo();

    // --- Vía 1: deep link con token ---
    if (parametro && /^[a-f0-9]{32}$/.test(parametro)) {
        const cliente = await Clientes.findOne({
            telegramLinkToken: hashCodigo(parametro),
            telegramLinkExpires: { $gt: new Date() },
        });

        if (cliente) {
            if (modo === 'beta' && !cliente.telegramBeta) {
                await TelegramChat.updateOne({ _id: chat._id }, { $set: { enEspera: true, origen: 'perfil' } });
                return responder(chat.chatId, TEXTOS.esperaBeta);
            }
            await vincularChat(chat, cliente, 'deep_link');
            return responder(chat.chatId, TEXTOS.bienvenida(cliente.nombre), tg.tecladoMenu());
        }
        // Token caducado o ya usado: no se deja al usuario en un error seco.
        await responder(chat.chatId, TEXTOS.tokenInvalido);
    } else if (parametro) {
        // Origen del QR o de una campaña: 'qr-caja', 'email-oct'…
        await TelegramChat.updateOne({ _id: chat._id }, { $set: { origen: parametro.slice(0, 40) } });
    }

    // ¿Ya estaba vinculado?
    if (chat.clienteId) {
        const cliente = await Clientes.findById(chat.clienteId);
        if (cliente) return responder(chat.chatId, TEXTOS.yaVinculado(cliente.nombre), tg.tecladoMenu());
    }

    // --- Vía 2: pedir el teléfono ---
    return responder(chat.chatId, TEXTOS.pedirTelefono, tg.tecladoCompartirTelefono());
}

/**
 * El usuario compartió un contacto.
 *
 * 🚩 Se comprueba que el contacto sea SUYO. Telegram permite reenviar el
 * contacto de otra persona; sin esta comprobación, cualquiera podría vincularse
 * a la ficha ajena y ver sus puntos, su dirección y sus premios.
 */
async function manejarContacto(chat, from, contact) {
    if (!contact.user_id || String(contact.user_id) !== String(from.id)) {
        return responder(chat.chatId, TEXTOS.contactoAjeno, tg.tecladoCompartirTelefono());
    }

    const telefono = limpiarTelefono(contact.phone_number);
    const cliente = await buscarClientePorTelefono(telefono);
    const modo = await obtenerModo();

    if (!cliente) {
        // Sin ficha: se guarda igual. Es un contacto que hoy se perdería, y
        // aparecerá en el panel como "suscriptor sin ficha" para darlo de alta.
        await TelegramChat.updateOne({ _id: chat._id }, { $set: { telefono } });
        // En modo público se le da de alta aquí mismo; en beta, solo entra la lista.
        if (modo === 'publico') return registro.empezar(chat, telefono, depsRegistro());
        return responder(chat.chatId, TEXTOS.noEncontrado, tg.quitarTeclado());
    }

    if (modo === 'beta' && !cliente.telegramBeta) {
        await TelegramChat.updateOne({ _id: chat._id }, { $set: { enEspera: true, telefono } });
        return responder(chat.chatId, TEXTOS.esperaBeta, tg.quitarTeclado());
    }

    await vincularChat(chat, cliente, 'contacto');
    return responder(chat.chatId, TEXTOS.bienvenida(cliente.nombre), tg.tecladoMenu());
}

const depsRegistro = () => ({ responder, vincularChat, bienvenida: TEXTOS.bienvenida });

/**
 * Vía 3: `/vincular` con código de 6 dígitos.
 * Para quien registró Telegram con un número distinto al que nos dio.
 */
async function manejarVincular(chat, texto) {
    const codigo = (texto.match(/\b(\d{6})\b/) || [])[1];

    if (!codigo) {
        return responder(chat.chatId,
            'Para conectarte con un código:\n\n' +
            '1. Entra a tu perfil en freshmarket.mx\n' +
            '2. Pulsa «Conectar Telegram» y copia el código de 6 dígitos\n' +
            '3. Escríbelo aquí como: <code>/vincular 123456</code>');
    }

    const cliente = await Clientes.findOne({
        telegramLinkCodigo: hashCodigo(codigo),
        telegramLinkExpires: { $gt: new Date() },
    });
    if (!cliente) return responder(chat.chatId, TEXTOS.tokenInvalido);

    const modo = await obtenerModo();
    if (modo === 'beta' && !cliente.telegramBeta) {
        await TelegramChat.updateOne({ _id: chat._id }, { $set: { enEspera: true } });
        return responder(chat.chatId, TEXTOS.esperaBeta);
    }

    await vincularChat(chat, cliente, 'codigo');
    return responder(chat.chatId, TEXTOS.bienvenida(cliente.nombre), tg.tecladoMenu());
}

/** /baja y /promos: solo gobiernan las campañas, no los transaccionales. */
async function manejarBaja(chat, alta = false) {
    await TelegramChat.updateOne({ _id: chat._id }, {
        $set: alta
            ? { optIn: true, optInAt: new Date() }
            : { optIn: false, optOutAt: new Date() },
    });
    if (chat.clienteId) {
        await Clientes.updateOne({ _id: chat.clienteId }, {
            $set: alta ? { telegramOptIn: true } : { telegramOptIn: false, telegramOptOutAt: new Date() },
        });
    }
    return responder(chat.chatId, alta ? TEXTOS.altaPromos : TEXTOS.baja);
}

// ---------------------------------------------------------------------------
// Consultas (solo lectura)
// ---------------------------------------------------------------------------

const PREMIO_TARJETA = '1 producto de hasta $80';

async function consultarSellos(chat, cliente) {
    return responder(chat.chatId, textoSellos(cliente), tg.tecladoMenu());
}

async function consultarPuntos(chat, cliente) {
    return responder(chat.chatId, textoPuntos(cliente), tg.tecladoMenu());
}

/** Botón «Sellos y puntos»: las dos cosas en un solo mensaje. */
async function consultarSellosYPuntos(chat, cliente) {
    return responder(chat.chatId, `${textoSellos(cliente)}\n\n${textoPuntos(cliente)}`, tg.tecladoMenu());
}

function textoSellos(cliente) {
    const sellos = Math.min(Number(cliente.sellos) || 0, 8);
    const tarjeta = '🟢'.repeat(sellos) + '⚪'.repeat(8 - sellos);
    let texto = `🎟️ <b>Tu tarjeta de sellos</b>\n\n${tarjeta}\n<b>${sellos} de 8</b>\n\n`;

    if (cliente.premioDisponible) {
        texto += `🎉 <b>¡Ya tienes tu premio!</b> En tu próximo pedido puedes canjear ${PREMIO_TARJETA}.`;
    } else {
        const faltan = 8 - sellos;
        texto += `Te ${faltan === 1 ? 'falta' : 'faltan'} <b>${faltan}</b> para tu premio: ${PREMIO_TARJETA}.\n\n` +
            '<i>Ganas 1 sello por cada semana que haces pedido. No tienen que ser semanas seguidas.</i>';
    }
    return texto;
}

function textoPuntos(cliente) {
    const puntos = Math.max(Number(cliente.puntos) || 0, 0);
    return puntos > 0
        ? `⭐ Tienes <b>${puntos.toLocaleString('es-MX')} puntos</b>.\n\nÚsalos como descuento en tu próximo pedido.`
        : '⭐ Aún no tienes puntos.\n\nGanas puntos con cada compra y los usas como descuento.';
}

async function consultarPedido(chat, cliente) {
    const tel = limpiarTelefono(cliente.telefono);
    const ultimo = await Pedido.findOne({ telefono: { $regex: tel + '$' } })
        .sort({ createdAt: -1 }).lean();

    if (!ultimo) {
        return responder(chat.chatId,
            '📦 Aún no tenemos pedidos registrados con tu cuenta.\n\n' +
            'Pide en https://freshmarket.mx o por WhatsApp: https://wa.me/527712346620',
            tg.tecladoMenu());
    }

    // Un checkout se guarda en varios documentos (uno por despensa + los sueltos):
    // se juntan los del mismo día de entrega para mostrar el pedido completo.
    const mismos = await Pedido.find({
        telefono: { $regex: tel + '$' },
        fecha: ultimo.fecha,
    }).lean();

    // Despensas primero, productos sueltos al final.
    mismos.sort((a, b) =>
        (String(a.despensa).toLowerCase() === 'pedido') - (String(b.despensa).toLowerCase() === 'pedido'));
    const lineas = mismos.map((p) => {
        const nombre = String(p.despensa).toLowerCase() === 'pedido' ? 'Productos sueltos' : `Despensa ${p.despensa}`;
        const qty = Number(p.despensaQuantity) > 1 ? ` ×${p.despensaQuantity}` : '';
        return `• ${E(nombre)}${qty}`;
    });
    const total = mismos.reduce((a, p) => a + (Number(p.total) || 0), 0);

    const texto = `📦 <b>Tu último pedido</b>\n\n` +
        `🗓️ Entrega: ${E(ultimo.fecha)}\n` +
        `${lineas.join('\n')}\n\n` +
        `💰 Total: <b>$${total.toLocaleString('es-MX')}</b>`;
    return responder(chat.chatId, texto, tg.tecladoMenu());
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

/** Cantidad legible: 1000 g -> "1 kg", 500 g -> "500 g", 2 pza -> "2 pza". */
function cantidadLegible(cantidad, unidad) {
    const n = Number(cantidad) || 0;
    const u = String(unidad || '').toLowerCase();
    if (u === 'g' && n >= 1000) return `${+(n / 1000).toFixed(2)} kg`;
    if (u === 'ml' && n >= 1000) return `${+(n / 1000).toFixed(2)} L`;
    return `${n} ${unidad || ''}`.trim();
}

/**
 * Las despensas que se venden: las visibles en la tienda y con precio.
 * Excluye las pseudo-despensas 'Pedido' (productos sueltos) y 'REPOSICION'.
 */
async function despensasALaVenta() {
    return Despensas.find({ showInWeb: true, price: { $gt: 0 } })
        .populate('products.productId', 'title')
        .sort({ price: 1 })
        .lean();
}

/**
 * Manda el catálogo: una foto por despensa con su precio y contenido, y un
 * botón que abre la tienda dentro de Telegram. No exige estar vinculado: ver
 * el catálogo no expone datos de nadie, y la tienda pide el teléfono al pagar.
 */
async function mostrarDespensas(chat) {
    const despensas = await despensasALaVenta();
    if (!despensas.length) {
        return responder(chat.chatId, 'Ahora mismo no hay despensas disponibles. Vuelve a intentarlo más tarde 🙏');
    }
    const precio = (d) => `$${Number(d.price).toLocaleString('es-MX')}`;

    // 1) Las fotos juntas, en álbum: solo nombre y precio (el contenido se ve en la foto).
    const conFoto = despensas.filter((d) => d.img);
    let fotosOk = false;
    if (conFoto.length >= 2) {
        const r = await tg.enviarAlbum({
            chatId: chat.chatId,
            fotos: conFoto.map((d) => ({ foto: d.img, pie: `<b>Despensa ${E(d.name)}</b> — <b>${precio(d)}</b>` })),
        });
        fotosOk = r.ok;
    }
    // Si el álbum falla (una foto caída en imgbb tumba todo el álbum), una por una.
    if (!fotosOk) {
        for (const d of conFoto) {
            await tg.enviarFoto({ chatId: chat.chatId, foto: d.img, pie: `<b>Despensa ${E(d.name)}</b> — <b>${precio(d)}</b>` });
        }
    }

    // 2) Botones para elegir la que le interesa.
    const botones = despensas.map((d) => ({ text: `${d.name} — ${precio(d)}`, callback_data: `desp:${String(d.name).slice(0, 40)}` }));
    const filas = [];
    for (let i = 0; i < botones.length; i += 2) filas.push(botones.slice(i, i + 2));
    return responder(chat.chatId, '🛒 <b>¿Cuál despensa te interesa?</b> 👇', { inline_keyboard: filas });
}

/** Eligió una despensa: ¿la pide por chat o en línea? */
async function elegirDespensa(chat, nombre) {
    const d = (await despensasALaVenta()).find((x) => x.name === nombre);
    if (!d) return responder(chat.chatId, 'Esa despensa ya no está disponible 😕 Toca 🛒 Despensas para ver las de hoy.');
    return responder(chat.chatId,
        `<b>Despensa ${E(d.name)}</b> — <b>$${Number(d.price).toLocaleString('es-MX')}</b> 👌\n\n¿Cómo quieres pedirla?`,
        { inline_keyboard: [[
            { text: '💬 Por chat', callback_data: `pedir:${String(d.name).slice(0, 40)}` },
            { text: '🌐 En línea', web_app: { url: tg.urlTienda('catalogo') } },
        ]] });
}

// ---------------------------------------------------------------------------
// Pedido por chat (agente de IA)
// ---------------------------------------------------------------------------

/** Parte un texto largo: Telegram admite 4096 caracteres por mensaje. */
function trozos(texto, max = 3800) {
    const out = [];
    let resto = String(texto);
    while (resto.length > max) {
        let corte = resto.lastIndexOf('\n', max);
        if (corte < max / 2) corte = max;
        out.push(resto.slice(0, corte));
        resto = resto.slice(corte).replace(/^\n/, '');
    }
    if (resto) out.push(resto);
    return out;
}

async function conversarConAgente(chat, contenido) {
    // El agente necesita la ficha: dirección, costo de envío, nombre.
    if (!chat.clienteId) {
        return responder(chat.chatId,
            'Para pedir por chat primero necesito saber quién eres 🙂\n\nComparte tu teléfono con el botón de abajo:',
            tg.tecladoCompartirTelefono());
    }
    if (await estaCerrado()) {
        const conv = await pedidoCasiListo(chat.chatId);
        if (!conv) return responderCerrado(chat);
        if (conv.solicitudTardia && conv.solicitudTardia.estado === 'esperando') {
            return responder(chat.chatId, 'Ya le pregunté al equipo por tu pedido 🙌 Te aviso aquí en cuanto respondan.');
        }
        return responder(chat.chatId,
            'Ya cerramos los pedidos de esta semana a las 7 pm 🙏 pero tenías este pedido casi listo:\n\n' +
            `${E(conv.cotizacion.resumen)}\n\n¿Quieres que le pregunte al equipo si todavía lo podemos meter?`,
            { inline_keyboard: [[
                { text: '🙋 Sí, pregúntales', callback_data: 'tarde:pedir' },
                { text: 'No, gracias', callback_data: 'tarde:nada' },
            ]] });
    }
    await tg.enviarAccion(chat.chatId, 'typing');
    let texto;
    try {
        texto = await agente.responderCliente({
            chatId: chat.chatId, clienteId: chat.clienteId, contenido,
            // Las fotos se mandan en el momento en que el agente las pide, así
            // llegan antes de su mensaje de texto.
            enviarLista: () => lista.enviarLista(chat.chatId, {
                avisar: () => responder(chat.chatId, 'Te preparo la lista con los precios de hoy, dame unos segundos ⏳'),
            }),
            enviarFotos: async (fotos) => {
                let n = 0;
                for (const f of fotos) {
                    const r = await tg.enviarFoto({ chatId: chat.chatId, foto: f.foto, pie: E(f.pie) });
                    if (r.ok) n++;
                }
                await tg.enviarAccion(chat.chatId, 'typing');
                return n;
            },
        });
    } catch (e) {
        console.error('❌ agente:', e.status || '', e.message);
        texto = 'Uy, tuve un problema para responderte 😓 Intenta de nuevo en un momento, ' +
            'o escríbenos por WhatsApp: https://wa.me/527712346620';
    }
    // El agente escribe texto plano: se escapa todo para que un "<" no rompa el envío.
    for (const parte of trozos(texto)) await responder(chat.chatId, E(parte), tg.tecladoMenu());
    return { ok: true };
}

// PDFs que mandó un admin y esperan su «sí». En memoria a propósito: si el bot
// se reinicia en esos segundos, basta con volver a mandar el archivo.
const listasPendientes = new Map();
const imagenesPendientes = new Map();   // imagen de un admin esperando que diga qué es

async function guardarImagenAdmin(chat, from, tipo, fileId) {
    const nombreAdmin = [from.first_name, from.last_name].filter(Boolean).join(' ');
    await lista.guardarImagenSemana(tipo, { fileId, userId: from.id, nombreAdmin });
    const img = await lista.imagenSemana(tipo);
    const hasta = img ? new Date(img.vence).toLocaleString('es-MX', {
        timeZone: 'America/Mexico_City', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit',
    }) : '';
    return responder(chat.chatId,
        `✅ Listo: desde ahora mando esta imagen como <b>${lista.TIPOS_IMAGEN[tipo].titulo}</b>` +
        (hasta ? `, hasta el ${hasta}.` : '.'));
}
const PENDIENTE_MIN = 15;

async function confirmarListaManual(chat, from, archivo) {
    const r = await lista.guardarListaManual({
        fileId: archivo.fileId, nombre: archivo.nombre, userId: from.id, nombreAdmin: from.first_name,
    });
    const vence = new Date(r.vence).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', weekday: 'long', day: 'numeric', month: 'long' });
    return responder(chat.chatId,
        `✅ <b>Lista actualizada</b>: ${E(r.nombre)}\n\n` +
        `Se la mandaré a quien la pida hasta el <b>${E(vence)} a las 7 pm</b>, cuando cierran los pedidos de la semana. ` +
        'Si el lunes no subes la nueva, mandaré la generada con los precios del panel.\n\n' +
        '⚠️ El bot cobra los precios del panel: si cambiaste alguno en el PDF, cámbialo también allí.\n\n' +
        'Para volver a la generada antes: /quitarlista');
}

/**
 * Pedido fuera de horario:
 *   tarde:pedir / tarde:nada    -> el cliente decide si se lo pregunta al equipo
 *   tarde:ok:<id> / tarde:no:<id> -> un admin lo acepta o lo rechaza
 */
async function manejarPedidoTardio(chat, cb, data) {
    if (data === 'tarde:nada') {
        return responder(chat.chatId, 'Va 👍 Las nuevas opciones salen el lunes después de las 11 am. ¡Te esperamos!', tg.tecladoMenu());
    }

    if (data === 'tarde:pedir') {
        const conv = await pedidoCasiListo(chat.chatId);
        if (!conv) return responderCerrado(chat);
        if (!conv.solicitudTardia) {
            conv.solicitudTardia = { estado: 'esperando', at: new Date() };
            conv.markModified('solicitudTardia');
            await conv.save();
            const cliente = await Clientes.findById(conv.clienteId).lean();
            const ids = String(process.env.TELEGRAM_ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
            for (const id of ids) {
                await tg.enviarMensaje({
                    chatId: id,
                    texto: '🕖 <b>Pedido fuera de horario</b>\n\n' +
                        `👤 ${E(cliente ? cliente.nombre : '(sin ficha)')} · ${E(cliente ? cliente.telefono : '')}\n\n` +
                        `${E(conv.cotizacion.resumen)}\n\n` +
                        `Lo cotizó ${E(new Date(conv.cotizadaAt).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', weekday: 'long', hour: '2-digit', minute: '2-digit' }))}, ` +
                        'antes del cierre. ¿Entra?',
                    replyMarkup: { inline_keyboard: [[
                        { text: '✅ Aceptar', callback_data: `tarde:ok:${conv._id}` },
                        { text: '❌ Rechazar', callback_data: `tarde:no:${conv._id}` },
                    ]] },
                }).catch(() => {});
            }
        }
        return responder(chat.chatId, 'Listo, ya le pregunté al equipo 🙌 Te aviso aquí en cuanto respondan.');
    }

    // Decisión del admin
    const m = data.match(/^tarde:(ok|no):([a-f0-9]{24})$/);
    if (!m || !lista.esAdmin(cb.from.id)) return null;
    const conv = await Conversacion.findById(m[2]);
    if (!conv || !conv.solicitudTardia) return responder(chat.chatId, 'Ya no encuentro ese pedido.');
    if (conv.solicitudTardia.estado !== 'esperando') {
        return responder(chat.chatId, `Ese pedido ya se ${conv.solicitudTardia.estado === 'aceptada' ? 'aceptó' : 'rechazó'} (${E(conv.solicitudTardia.decidioPor || '')}).`);
    }

    const quien = cb.from.first_name || String(cb.from.id);
    if (m[1] === 'no') {
        conv.solicitudTardia = { ...conv.solicitudTardia, estado: 'rechazada', decidioPor: quien, decididoAt: new Date() };
        conv.cotizacion = null;
        conv.markModified('solicitudTardia'); conv.markModified('cotizacion');
        await conv.save();
        await responder(conv.chatId,
            'Esta vez ya no alcanzamos a meter tu pedido 😔\n\n' +
            'Las nuevas despensas y la lista de precios salen el <b>lunes después de las 11 am</b>. ¡Te esperamos!', tg.tecladoMenu());
        return responder(chat.chatId, '❌ Rechazado. Ya le avisé al cliente.');
    }

    try {
        const r = await agente.crearPedidosDeCotizacion(conv);
        conv.solicitudTardia = { ...conv.solicitudTardia, estado: 'aceptada', decidioPor: quien, decididoAt: new Date() };
        conv.markModified('solicitudTardia');
        await conv.save();
        await responder(conv.chatId,
            `✅ <b>¡Buenas noticias!</b> El equipo aceptó tu pedido y ya quedó registrado.\n\nTotal: <b>$${Number(r.total).toLocaleString('es-MX')}</b>`, tg.tecladoMenu());
        return responder(chat.chatId, '✅ Aceptado y registrado. Ya le avisé al cliente.');
    } catch (e) {
        console.error('❌ aceptar pedido tardío:', e.message);
        return responder(chat.chatId, `No pude registrar el pedido: ${E(e.message)}`);
    }
}

/** Toques en los botones de los mensajes (por ahora, «Pedir por chat» del catálogo). */
async function procesarBoton(cb) {
    const data = String(cb.data || '');
    await tg.responderBoton(cb.id);
    if (!cb.message || !cb.message.chat || cb.message.chat.type !== 'private') return;

    const chat = await registrarChat(cb.from, cb.message.chat);
    if (data === 'lista:si' || data === 'lista:no') {
        const p = listasPendientes.get(chat.chatId);
        listasPendientes.delete(chat.chatId);
        if (!lista.esAdmin(cb.from.id)) return null;
        if (data === 'lista:no') return responder(chat.chatId, 'Va, no cambio nada 👍');
        if (!p || Date.now() - p.at > PENDIENTE_MIN * 60000) {
            return responder(chat.chatId, 'Ya no tengo ese archivo a la mano. Mándamelo otra vez, por favor.');
        }
        return confirmarListaManual(chat, cb.from, p);
    }
    if (data.startsWith('img:')) {
        const p = imagenesPendientes.get(chat.chatId);
        imagenesPendientes.delete(chat.chatId);
        if (!lista.esAdmin(cb.from.id)) return null;
        if (!p || Date.now() - p.at > PENDIENTE_MIN * 60000) {
            return responder(chat.chatId, 'Ya no tengo esa imagen a la mano. Mándamela otra vez, por favor.');
        }
        if (data === 'img:pedido') {
            const img = await tg.descargarArchivo(p.fileId);
            if (!img) return responder(chat.chatId, 'No pude abrir esa foto 😕 ¿Me la mandas otra vez?');
            return conversarConAgente(chat, [
                { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } },
                { type: 'text', text: p.caption || 'Te mando mi lista.' },
            ]);
        }
        return guardarImagenAdmin(chat, cb.from, data === 'img:promos' ? 'promos' : 'regalos', p.fileId);
    }
    if (data.startsWith('rec:')) return manejarRecordatorio(chat, data);
    if (data.startsWith('tarde:')) return manejarPedidoTardio(chat, cb, data);
    if (data.startsWith('reg:')) {
        if (chat.clienteId) return null;           // ya tiene ficha: botón viejo
        return registro.manejarBoton(chat, data, depsRegistro());
    }
    if (data.startsWith('desp:')) {
        if (await estaCerrado()) return responderCerrado(chat);
        return elegirDespensa(chat, data.slice('desp:'.length));
    }
    if (data.startsWith('pedir:')) {
        const despensa = data.slice('pedir:'.length);
        return conversarConAgente(chat, [{ type: 'text', text: `Quiero pedir la despensa ${despensa}.` }]);
    }
}

// ---------------------------------------------------------------------------
// Entrada única
// ---------------------------------------------------------------------------

/**
 * Procesa un update. Lo llaman tanto el webhook como el polling.
 * Nunca lanza: un update mal formado no debe tumbar nada.
 */
async function procesarUpdate(update) {
    try {
        // El usuario bloqueó o desbloqueó al bot.
        if (update.my_chat_member) {
            const { chat, new_chat_member } = update.my_chat_member;
            const estado = new_chat_member && new_chat_member.status;
            const bloqueado = estado === 'kicked' || estado === 'left';
            await TelegramChat.updateOne(
                { chatId: String(chat.id) },
                { $set: { bloqueado, bloqueadoAt: bloqueado ? new Date() : null } },
            );
            console.log(`${bloqueado ? '🚫' : '✅'} chat ${chat.id} -> ${estado}`);
            return;
        }

        if (update.callback_query) return await procesarBoton(update.callback_query);

        const msg = update.message || update.edited_message;
        if (!msg || !msg.chat) return;

        // Solo chats privados: los de grupo se tratarán en el handoff (Paso 3).
        if (msg.chat.type !== 'private') return;

        const chat = await registrarChat(msg.from, msg.chat);
        const texto = String(msg.text || '').trim();

        if (msg.contact) return await manejarContacto(chat, msg.from, msg.contact);

        if (/^\/start\b/.test(texto)) {
            const parametro = texto.split(/\s+/)[1] || null;
            return await manejarStart(chat, msg.from, parametro);
        }
        if (/^\/vincular\b/.test(texto)) return await manejarVincular(chat, texto);
        if (/^\/baja\b/.test(texto)) return await manejarBaja(chat, false);
        if (/^\/promos\b/.test(texto)) return await manejarBaja(chat, true);
        if (/^\/(ayuda|help)\b/.test(texto) || texto === '❓ Ayuda') {
            return await responder(chat.chatId, TEXTOS.ayuda);
        }

        if (/^\/(cancelar|nuevo)\b/.test(texto) && !chat.clienteId && registro.enCurso(chat)) {
            await registro.cancelar(chat);
            return await responder(chat.chatId, 'Listo, dejé tu registro a un lado. Cuando quieras, toca /start 🙂', tg.quitarTeclado());
        }
        if (/^\/(cancelar|nuevo)\b/.test(texto)) {
            await agente.cerrarConversacion(chat.chatId);
            return await responder(chat.chatId, 'Listo, empezamos de cero 👍 ¿Qué te gustaría pedir?', tg.tecladoMenu());
        }

        // Alta de cliente nuevo en curso: el texto o la ubicación son su respuesta.
        if (!chat.clienteId && registro.enCurso(chat) && (texto || msg.location)) {
            return await registro.manejarMensaje(chat, msg, depsRegistro());
        }

        // Un admin manda un PDF: se le pregunta si es la lista de la semana. Así
        // da igual si escribe /lista en el mismo envío, después o nunca.
        if (msg.document) {
            const esPdf = msg.document.mime_type === 'application/pdf' || /\.pdf$/i.test(msg.document.file_name || '');
            if (esPdf && lista.esAdmin(msg.from.id)) {
                const archivo = { fileId: msg.document.file_id, nombre: msg.document.file_name || 'lista.pdf' };
                if (/^\/lista\b/i.test(String(msg.caption || '').trim())) {
                    return await confirmarListaManual(chat, msg.from, archivo);
                }
                listasPendientes.set(chat.chatId, { ...archivo, at: Date.now() });
                return await responder(chat.chatId,
                    `📄 Recibí <b>${E(archivo.nombre)}</b>.\n\n¿La uso como lista de precios de la semana?`,
                    { inline_keyboard: [[
                        { text: '✅ Sí, usarla', callback_data: 'lista:si' },
                        { text: 'No', callback_data: 'lista:no' },
                    ]] });
            }
            return await responder(chat.chatId,
                'Todavía no puedo leer archivos 😅 Si es tu lista, mándamela como foto o escríbela aquí.');
        }
        if (/^\/quitarlista\b/.test(texto) && lista.esAdmin(msg.from.id)) {
            await lista.quitarListaManual();
            return await responder(chat.chatId, '✅ Listo: desde ahora se manda la lista generada con los precios del panel.');
        }

        // Un admin manda una imagen: puede ser la de promos o regalos de la semana.
        if (msg.photo && msg.photo.length && lista.esAdmin(msg.from.id)) {
            const grande = msg.photo[msg.photo.length - 1];
            const caption = String(msg.caption || '').trim().toLowerCase();
            const directo = /^\/promos\b/.test(caption) ? 'promos' : /^\/regalos\b/.test(caption) ? 'regalos' : null;
            if (directo) return await guardarImagenAdmin(chat, msg.from, directo, grande.file_id);
            imagenesPendientes.set(chat.chatId, { fileId: grande.file_id, caption: msg.caption || '', at: Date.now() });
            return await responder(chat.chatId, '🖼️ ¿Qué es esta imagen?', { inline_keyboard: [
                [{ text: '🏷️ Promociones de la semana', callback_data: 'img:promos' }],
                [{ text: '🎁 Regalos de la semana', callback_data: 'img:regalos' }],
                [{ text: '🛒 Es para un pedido', callback_data: 'img:pedido' }],
            ] });
        }

        // Foto (por ejemplo, de su lista escrita a mano): al agente.
        if (msg.photo && msg.photo.length) {
            const grande = msg.photo[msg.photo.length - 1];   // Telegram manda varias resoluciones
            const img = await tg.descargarArchivo(grande.file_id);
            if (!img) return await responder(chat.chatId, 'No pude abrir esa foto 😕 ¿Me la mandas otra vez?');
            return await conversarConAgente(chat, [
                { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } },
                { type: 'text', text: msg.caption || 'Te mando mi lista.' },
            ]);
        }

        // Lista de precios en PDF: abierta a cualquiera que llegue al bot.
        if (/^\/(lista|precios)\b/.test(texto) || texto === '📄 Lista de precios') {
            if (await estaCerrado()) return await responderCerrado(chat);
            const r = await lista.enviarLista(chat.chatId, {
                avisar: () => responder(chat.chatId, 'Te preparo la lista con los precios de hoy, dame unos segundos ⏳'),
            });
            if (!r.ok) await responder(chat.chatId, 'No pude preparar la lista ahora 😓 Inténtalo en un momento.');
            return r;
        }

        // Catálogo: abierto a cualquiera que llegue al bot.
        if (/^\/(despensas|menu|catalogo)\b/.test(texto) || texto === '🛒 Despensas') {
            if (await estaCerrado()) return await responderCerrado(chat);
            return await mostrarDespensas(chat);
        }

        // Consultas: por comando o por botón del menú. Requieren estar vinculado.
        const esAmbos = texto === '🎟️ Sellos y puntos';
        const esSellos = /^\/missellos\b/.test(texto) || texto === '🎟️ Mis sellos';
        const esPuntos = /^\/mispuntos\b/.test(texto) || texto === '⭐ Mis puntos';
        const esPedido = /^\/mipedido\b/.test(texto) || texto === '📦 Mi pedido';
        if ((esAmbos || esSellos || esPuntos || esPedido) && chat.clienteId) {
            const cliente = await Clientes.findById(chat.clienteId).lean();
            if (cliente) {
                if (esAmbos) return await consultarSellosYPuntos(chat, cliente);
                if (esSellos) return await consultarSellos(chat, cliente);
                if (esPuntos) return await consultarPuntos(chat, cliente);
                return await consultarPedido(chat, cliente);
            }
        }

        // Texto libre de alguien vinculado: lo atiende el agente de pedidos.
        if (chat.clienteId && texto) {
            return await conversarConAgente(chat, [{ type: 'text', text: texto.slice(0, 2000) }]);
        }

        if (!chat.clienteId) {
            // Escribió un número a mano: se explica por qué no vale, en vez de
            // repetir el mismo mensaje y dejarle sin saber qué hizo mal.
            const pareceTelefono = /^[\d\s()+-]{8,}$/.test(texto) && texto.replace(/\D/g, '').length >= 10;
            return await responder(
                chat.chatId,
                pareceTelefono ? TEXTOS.telefonoEscrito : TEXTOS.pedirTelefono,
                tg.tecladoCompartirTelefono(),
            );
        }
        return await responder(chat.chatId, TEXTOS.ayuda, tg.tecladoMenu());
    } catch (e) {
        console.error('❌ procesarUpdate:', e.message);
    }
}

// ---------------------------------------------------------------------------
// Aviso de apertura
// ---------------------------------------------------------------------------

/**
 * Quien escribió con los pedidos cerrados (fin de semana) recibe las despensas
 * nuevas en cuanto abren: el lunes a las 11 o antes, si el panel las marca como
 * listas. Cada chat se reclama con un update atómico, así que dos revisiones a
 * la vez nunca mandan el aviso dos veces.
 */
let revisando = false;
async function revisarAperturas() {
    if (revisando) return 0;
    revisando = true;
    let enviados = 0;
    try {
        if (await estaCerrado()) return 0;
        const desde = new Date(Date.now() - 7 * 86400000);   // uno de hace más de una semana ya no aplica
        for (;;) {
            const chat = await TelegramChat.findOneAndUpdate(
                { avisarApertura: { $ne: null } },
                { $set: { avisarApertura: null } },
                { new: false },
            );
            if (!chat) break;
            if (chat.bloqueado || chat.avisarApertura < desde) continue;
            await responder(chat.chatId, '¡Ya están las despensas de esta semana! 🥬 Aquí te van:');
            await mostrarDespensas(chat);
            enviados++;
            await new Promise((ok) => setTimeout(ok, 300));   // sin prisa: muy por debajo del límite de Telegram
        }
        if (enviados) console.log(`🔔 Aviso de apertura enviado a ${enviados} chat(s)`);
    } catch (e) {
        console.error('❌ revisarAperturas:', e.message);
    } finally {
        revisando = false;
    }
    return enviados;
}

// ---------------------------------------------------------------------------
// Recordatorio de confirmación
// ---------------------------------------------------------------------------

/** "viernes, 16 Octubre 2026" -> "viernes 16 de octubre" */
function fechaBonita(fecha) {
    const m = String(fecha || '').match(/^(\S+?),?\s+(\d{1,2})\s+(\S+)/);
    return m ? `${m[1].toLowerCase()} ${m[2]} de ${m[3].toLowerCase()}` : String(fecha || '');
}

/**
 * Cotizaciones sin respuesta tras 1 h: se pide la autorización una sola vez,
 * con botones. Solo de 8 am a 9 pm, para no escribir de noche.
 */
let revisandoRec = false;
async function revisarRecordatorios() {
    if (revisandoRec) return 0;
    revisandoRec = true;
    let enviados = 0;
    try {
        const hora = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City', hour: 'numeric', hour12: false }));
        if (hora < 8 || hora >= 21 || await estaCerrado()) return 0;
        for (let conv; (conv = await agente.reclamarRecordatorio());) {
            const chat = await TelegramChat.findOne({ chatId: conv.chatId }).lean();
            if (!chat || chat.bloqueado) continue;
            await responder(conv.chatId,
                `Hola 👋 Necesito tu autorización para confirmar tu pedido e ingresarlo a las entregas del ` +
                `<b>${E(fechaBonita(conv.cotizacion.fecha))}</b>:\n\n${E(conv.cotizacion.resumen)}\n\n¿Lo confirmas?`,
                { inline_keyboard: [
                    [{ text: '✅ Sí, confírmalo', callback_data: `rec:si:${conv._id}` }],
                    [{ text: '✏️ Quiero cambiar algo', callback_data: `rec:cambiar:${conv._id}` },
                        { text: '❌ No, gracias', callback_data: `rec:no:${conv._id}` }],
                ] });
            enviados++;
        }
        if (enviados) console.log(`⏰ Recordatorio de confirmación enviado a ${enviados} chat(s)`);
    } catch (e) {
        console.error('❌ revisarRecordatorios:', e.message);
    } finally {
        revisandoRec = false;
    }
    return enviados;
}

async function manejarRecordatorio(chat, data) {
    const [, accion, convId] = data.split(':');
    if (accion === 'cambiar') {
        return responder(chat.chatId, 'Claro 🙂 Dime qué quieres cambiar y lo ajusto.');
    }
    if (accion === 'no') {
        await agente.cerrarConversacion(chat.chatId);
        return responder(chat.chatId, 'Va, no lo registro 👍 Cuando quieras pedir, aquí estoy.', tg.tecladoMenu());
    }
    if (await estaCerrado()) return responderCerrado(chat);
    let r;
    try {
        r = await agente.confirmarDesdeRecordatorio(convId, chat.chatId);
    } catch (e) {
        console.error('❌ confirmar desde recordatorio:', e.message);
        return responder(chat.chatId, `Uy, no pude registrarlo 😓 ${E(e.message)}`);
    }
    if (r.estado === 'creado') {
        return responder(chat.chatId,
            `¡Listo! ✅ Tu pedido quedó registrado para el <b>${E(fechaBonita(r.fecha))}</b>.\n` +
            `Total: <b>$${Math.round(r.total).toLocaleString('es-MX')}</b>` +
            (r.promociones.length ? `\n\n🎉 Además te ganaste: ${E(r.promociones.join(', '))}` : '') +
            '\n\n¡Gracias por tu compra! 🥬', tg.tecladoMenu());
    }
    if (r.estado === 'cambio') {
        return responder(chat.chatId,
            `Algo cambió desde que lo cotizamos (precio o disponibilidad). Así queda ahora:\n\n${E(r.resumen)}\n\n` +
            '¿Lo confirmas? Escríbeme «sí» o dime qué cambiar.');
    }
    if (r.estado === 'error') {
        return responder(chat.chatId, `No pude confirmarlo así: ${E(r.mensaje)}\n\nDime y lo ajustamos 🙂`);
    }
    return responder(chat.chatId, 'Ese pedido ya no está pendiente. Si quieres pedir, escríbeme 🙂', tg.tecladoMenu());
}

let timerAperturas = null;
function iniciarAvisosApertura(cadaMs = 5 * 60000) {
    if (timerAperturas) return;
    timerAperturas = setInterval(() => { revisarAperturas(); revisarRecordatorios(); }, cadaMs);
    timerAperturas.unref();
}

/** Comandos que ve el usuario al pulsar "/". */
const COMANDOS = [
    { command: 'start', description: 'Conectar mi cuenta' },
    { command: 'despensas', description: 'Ver despensas y precios' },
    { command: 'lista', description: 'Lista de precios en PDF' },
    { command: 'missellos', description: 'Ver mis sellos' },
    { command: 'mispuntos', description: 'Ver mis puntos' },
    { command: 'mipedido', description: 'Mi último pedido' },
    { command: 'cancelar', description: 'Empezar un pedido de cero' },
    { command: 'ayuda', description: 'Ayuda' },
    { command: 'baja', description: 'Dejar de recibir promociones' },
];

module.exports = {
    procesarUpdate, responder, vincularChat, registrarChat,
    buscarClientePorTelefono, limpiarTelefono, obtenerModo,
    COMANDOS, TEXTOS, mostrarDespensas, despensasALaVenta,
    revisarAperturas, revisarRecordatorios, iniciarAvisosApertura, fechaBonita,
};
