const mongoose = require('mongoose');

/**
 * Un chat de Telegram vinculado (o por vincular) a Fresh Market.
 *
 * ¿Por qué una colección aparte y no campos en Clientes?
 * Porque alguien puede pulsar Start sin tener ficha: llega por el QR de la caja
 * o por un enlace, y todavía no es cliente. En `Clientes` no cabe —`nombre`,
 * `direccion` y `telefono` son obligatorios— y ese chat es justo un contacto que
 * hoy se perdería. Aquí vive hasta que se le dé de alta.
 *
 * `Clientes.telegramId` queda como puntero desnormalizado hacia aquí: permite
 * que el flujo de pedidos encole un mensaje sin una segunda consulta. Los dos
 * lados se escriben SIEMPRE desde la misma función (`vincularChat` en
 * routes/telegram.js) para que no se desincronicen.
 */
const TelegramChatSchema = new mongoose.Schema({
    // --- IDENTIDAD EN TELEGRAM ---
    // chatId es el identificador interno de Telegram. NO es un teléfono y no se
    // puede deducir: solo aparece cuando la persona escribe al bot.
    chatId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, default: null },
    username: { type: String, default: null },
    firstName: { type: String, default: null },
    lastName: { type: String, default: null },
    languageCode: { type: String, default: null },

    // --- VÍNCULO CON LA FICHA ---
    telefono: { type: String, default: null },   // 10 dígitos, si lo compartió
    clienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Clientes', default: null },
    vinculadoAt: { type: Date, default: null },
    // Cómo se vinculó: sirve para saber qué vía de captación funciona.
    metodoVinculacion: {
        type: String,
        enum: ['deep_link', 'contacto', 'codigo', 'registro', null],
        default: null,
    },

    // Alta de cliente nuevo a medias (utils/telegramRegistro.js):
    // { paso, telefono, nombre, cp, colonia, municipio, calle, gps, costoEnvio, gratisJueves, at }
    registro: { type: mongoose.Schema.Types.Mixed, default: null },

    // --- CONSENTIMIENTO ---
    // Separado a propósito: los mensajes transaccionales (su pedido, su premio)
    // van siempre a quien se vinculó; optIn solo gobierna las campañas.
    optIn: { type: Boolean, default: true },
    optInAt: { type: Date, default: null },
    optOutAt: { type: Date, default: null },

    // --- ESTADO ---
    // Se marca al recibir un update `my_chat_member` con status 'kicked', o al
    // fallar un envío con 403. Un chat bloqueado NO debe reintentarse nunca.
    bloqueado: { type: Boolean, default: false },
    bloqueadoAt: { type: Date, default: null },

    // --- ORIGEN Y ACTIVIDAD ---
    // El parámetro del deep link: 'perfil', 'qr-caja', 'email-oct'… Es lo que
    // permite medir qué vía de captación trae suscriptores.
    origen: { type: String, default: null },
    enEspera: { type: Boolean, default: false },
    // Escribió con los pedidos cerrados: recibe las despensas nuevas al abrir.
    avisarApertura: { type: Date, default: null },  // pulsó Start en modo beta sin estar en la lista
    ultimoInboundAt: { type: Date, default: null },
    ultimoOutboundAt: { type: Date, default: null },
    mensajesEnviados: { type: Number, default: 0 },
}, { timestamps: true });

TelegramChatSchema.index({ clienteId: 1 });
TelegramChatSchema.index({ telefono: 1 });
TelegramChatSchema.index({ optIn: 1, bloqueado: 1 });   // audiencia de campañas
TelegramChatSchema.index({ enEspera: 1 });
TelegramChatSchema.index({ avisarApertura: 1 }, { sparse: true });              // lista de espera en modo beta

module.exports = mongoose.model('TelegramChat', TelegramChatSchema);
