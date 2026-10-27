/**
 * Pasar dudas al equipo en vez de mandar al cliente a WhatsApp.
 *
 * El bot publica la pregunta en el grupo del equipo (TELEGRAM_GRUPO_EQUIPO) o,
 * si todavía no hay grupo, en el chat privado de cada admin (TELEGRAM_ADMIN_IDS).
 * Quien conteste con "Responder" sobre ese mensaje le manda la respuesta al
 * cliente. Cada mensaje del bot en el grupo queda ligado al chat del cliente en
 * TelegramHandoff, así las respuestas llegan a quien corresponde.
 *
 * Con el modo de privacidad del bot activado (lo normal), en el grupo el bot
 * solo recibe las respuestas a sus propios mensajes y los comandos: la plática
 * del equipo no le llega.
 */
const mongoose = require('mongoose');
const tg = require('./telegram');

const HandoffSchema = new mongoose.Schema({
    destChatId: { type: String, required: true },      // grupo o admin donde se publicó
    messageId: { type: Number, required: true },        // mensaje del bot al que se responde
    clienteChatId: { type: String, required: true },
    clienteNombre: { type: String, default: '' },
    motivo: { type: String, default: '' },
    pregunta: { type: String, default: '' },
    respuestas: [{ por: String, texto: String, at: Date, _id: false }],
}, { timestamps: true });
HandoffSchema.index({ destChatId: 1, messageId: 1 }, { unique: true });
HandoffSchema.index({ clienteChatId: 1, createdAt: -1 });
const Handoff = mongoose.models.TelegramHandoff || mongoose.model('TelegramHandoff', HandoffSchema);

const E = tg.escaparHTML;
const lista = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
const grupo = () => String(process.env.TELEGRAM_GRUPO_EQUIPO || '').trim();
const destinos = () => (grupo() ? [grupo()] : lista(process.env.TELEGRAM_ADMIN_IDS));
const esGrupoEquipo = (chatId) => Boolean(grupo()) && String(chatId) === grupo();

/**
 * Publica una duda para el equipo. `unaVezCadaMin` evita repetir el mismo aviso
 * (mismo cliente y motivo) si el cliente insiste. Devuelve true si llegó a alguien.
 */
async function preguntarAlEquipo({ clienteChatId, nombre, telefono, motivo = 'duda', pregunta, contexto, unaVezCadaMin = 0 }) {
    const dest = destinos();
    if (!dest.length || !tg.hayToken()) return false;
    if (unaVezCadaMin) {
        const reciente = await Handoff.findOne({
            clienteChatId: String(clienteChatId), motivo,
            createdAt: { $gte: new Date(Date.now() - unaVezCadaMin * 60000) },
        }).lean();
        if (reciente) return true;
    }

    const lineas = [
        '🙋 <b>Un cliente necesita ayuda</b>',
        '',
        `👤 ${E(nombre || 'Sin ficha')}${telefono ? ` · ${E(telefono)}` : ''}`,
    ];
    if (contexto) lineas.push(`📦 ${E(contexto)}`);
    lineas.push('', `❓ ${E(String(pregunta || '').slice(0, 1500))}`, '', '<i>Contesta con «Responder» sobre este mensaje y se lo mando al cliente.</i>');

    let enviados = 0;
    for (const d of dest) {
        const r = await tg.enviarMensaje({ chatId: d, texto: lineas.join('\n') });
        if (!r.ok) { console.log(`Equipo: no pude avisar a ${d}: ${r.desc || r.tipo}`); continue; }
        await Handoff.create({
            destChatId: String(d), messageId: r.resultado.message_id,
            clienteChatId: String(clienteChatId), clienteNombre: nombre || '', motivo,
            pregunta: String(pregunta || '').slice(0, 1500),
        });
        enviados++;
    }
    return enviados > 0;
}

/**
 * Si `msg` es una respuesta del equipo a un mensaje del bot ligado a un
 * cliente, se la reenvía. Devuelve true si la manejó.
 */
async function manejarRespuesta(msg) {
    const citado = msg.reply_to_message;
    if (!citado) return false;
    const h = await Handoff.findOne({ destChatId: String(msg.chat.id), messageId: citado.message_id });
    if (!h) return false;

    const quien = (msg.from && (msg.from.first_name || msg.from.username)) || 'Equipo';
    let r;
    let texto = '';
    if (msg.photo && msg.photo.length) {
        texto = String(msg.caption || '').trim();
        r = await tg.enviarFoto({
            chatId: h.clienteChatId,
            foto: msg.photo[msg.photo.length - 1].file_id,
            pie: '💬 <b>Fresh Market</b>' + (texto ? `\n\n${E(texto)}` : ''),
        });
    } else if (msg.text) {
        texto = msg.text.trim();
        r = await tg.enviarMensaje({ chatId: h.clienteChatId, texto: `💬 <b>Respuesta de Fresh Market</b>\n\n${E(texto)}` });
    } else {
        await tg.enviarMensaje({ chatId: msg.chat.id, texto: 'Por ahora solo puedo reenviar texto o fotos.', replyTo: msg.message_id });
        return true;
    }

    if (!r.ok) {
        const porque = r.tipo === 'bloqueado' ? 'el cliente bloqueó al bot' : (r.desc || 'error de Telegram');
        await tg.enviarMensaje({ chatId: msg.chat.id, texto: `⚠️ No le llegó a ${E(h.clienteNombre || 'el cliente')}: ${E(porque)}.`, replyTo: msg.message_id });
        return true;
    }
    h.respuestas.push({ por: quien, texto: texto.slice(0, 1500), at: new Date() });
    await h.save();

    // La confirmación también queda ligada al cliente: se puede seguir contestando sobre ella.
    const ok = await tg.enviarMensaje({
        chatId: msg.chat.id, replyTo: msg.message_id, disableNotification: true,
        texto: `✅ Se lo mandé a ${E(h.clienteNombre || 'el cliente')}.`,
    });
    if (ok.ok) {
        await Handoff.create({
            destChatId: String(msg.chat.id), messageId: ok.resultado.message_id,
            clienteChatId: h.clienteChatId, clienteNombre: h.clienteNombre, motivo: h.motivo, pregunta: h.pregunta,
        }).catch(() => {});
    }
    return true;
}

module.exports = { preguntarAlEquipo, manejarRespuesta, esGrupoEquipo, Handoff };
