const mongoose = require('mongoose');

/**
 * Una conversación de pedido por chat con el agente de IA.
 *
 * Se guarda en Mongo y no en memoria porque el bot puede reiniciarse (un
 * redeploy) a media conversación, y el cliente no tiene por qué notarlo.
 *
 * El historial (`mensajes`) es SOLO DE AÑADIR, nunca se edita: Claude Haiku 5.5
 * invalida su razonamiento previo si cambia cualquier cosa anterior en la
 * conversación — incluido el prompt de sistema. Por eso `sistema` y `snapshot`
 * se congelan al empezar y no se tocan hasta que la conversación termina.
 */
const TelegramConversacionSchema = new mongoose.Schema({
    chatId: { type: String, required: true, index: true },
    clienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Clientes', required: true },
    estado: { type: String, enum: ['activa', 'cerrada'], default: 'activa' },

    // Congelados al empezar (ver arriba).
    sistema: { type: [String], default: [] },
    snapshot: { type: mongoose.Schema.Types.Mixed, default: null },

    // Historial en el formato de la API de Anthropic, tal cual: incluye los
    // bloques de razonamiento, que deben volver sin modificar.
    mensajes: { type: [mongoose.Schema.Types.Mixed], default: [] },

    // Última cotización calculada por el servidor. `confirmar_pedido` ejecuta
    // ESTA, no lo que diga la IA en ese momento: así no puede cambiar nada entre
    // lo que el cliente vio y lo que se crea.
    cotizacion: { type: mongoose.Schema.Types.Mixed, default: null },
    cotizadaAt: { type: Date, default: null },

    pedidosCreados: { type: [String], default: [] },

    // Recordatorio "¿lo confirmas?" si el cliente no respondió a la cotización (una sola vez).
    recordatorioAt: { type: Date, default: null },

    // Pedido que se quiso confirmar después del cierre del viernes y que el
    // equipo aprueba o rechaza a mano: { estado: 'esperando'|'aceptada'|'rechazada', at, decidioPor }
    solicitudTardia: { type: mongoose.Schema.Types.Mixed, default: null },

    // Control de costo
    tokens: {
        entrada: { type: Number, default: 0 },
        salida: { type: Number, default: 0 },
        cacheLectura: { type: Number, default: 0 },
        cacheEscritura: { type: Number, default: 0 },
    },
    llamadas: { type: Number, default: 0 },

    ultimoMensajeAt: { type: Date, default: Date.now },
}, { timestamps: true });

TelegramConversacionSchema.index({ chatId: 1, estado: 1 });
// Limpieza: las conversaciones se borran solas a los 30 días de inactividad.
TelegramConversacionSchema.index({ ultimoMensajeAt: 1 }, { expireAfterSeconds: 30 * 86400 });

module.exports = mongoose.model('TelegramConversacion', TelegramConversacionSchema);
