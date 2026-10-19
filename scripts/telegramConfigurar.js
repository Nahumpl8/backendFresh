/**
 * Conecta el bot de PRODUCCIÓN con el backend (una vez, o tras cambiar el secreto).
 *
 *   railway run --service backendFresh --environment production node scripts/telegramConfigurar.js
 *
 * Usa las variables del entorno (token, secreto y ruta del webhook) sin
 * imprimirlas. Registra el webhook, los comandos y el botón «Pedir».
 * Con BORRAR=1 quita el webhook (rollback: el bot deja de recibir mensajes).
 */
require('dotenv').config();
const tg = require('../utils/telegram');

const BASE = (process.env.TELEGRAM_WEBHOOK_BASE || 'https://backendfresh-production.up.railway.app').replace(/\/+$/, '');

(async () => {
    const me = await tg.getMe();
    if (!me.ok) { console.error('🛑 Token inválido'); process.exit(1); }
    console.log(`Bot: @${me.resultado.username}`);
    // Seguro: solo configura el bot que se nombra en TELEGRAM_BOT_USERNAME. Evita
    // registrar por error un webhook al bot de pruebas (rompería el polling local).
    if (me.resultado.username !== process.env.TELEGRAM_BOT_USERNAME) {
        console.error(`🛑 El token es de @${me.resultado.username} pero TELEGRAM_BOT_USERNAME dice ${process.env.TELEGRAM_BOT_USERNAME}`);
        process.exit(1);
    }

    if (process.env.BORRAR === '1') {
        const r = await tg.deleteWebhook(false);
        console.log(r.ok ? '✅ Webhook quitado' : `❌ ${r.desc}`);
        return;
    }
    const { TELEGRAM_WEBHOOK_SECRET: secreto, TELEGRAM_WEBHOOK_PATH: ruta } = process.env;
    if (!secreto || !ruta) { console.error('🛑 Faltan TELEGRAM_WEBHOOK_SECRET o TELEGRAM_WEBHOOK_PATH'); process.exit(1); }

    const w = await tg.setWebhook({ url: `${BASE}/api/telegram/webhook/${ruta}`, secretToken: secreto });
    console.log(w.ok ? `✅ Webhook → ${BASE}/api/telegram/webhook/<ruta secreta>` : `❌ webhook: ${w.desc}`);

    const { COMANDOS } = require('../utils/telegramBot');
    const c = await tg.setMyCommands(COMANDOS);
    console.log(c.ok ? `✅ ${COMANDOS.length} comandos` : `❌ comandos: ${c.desc}`);

    // Botón junto a la caja de texto: lista de comandos con «Despensas» primero
    // (la tienda en línea queda en el botón «🌐 Pedido vía web» del teclado).
    const b = await tg.setBotonMenuComandos();
    console.log(b.ok ? '✅ Botón «Menú» (comandos)' : `❌ botón: ${b.desc}`);

    const info = await tg.getWebhookInfo();
    if (info.ok) console.log(`Pendientes: ${info.resultado.pending_update_count} · último error: ${info.resultado.last_error_message || 'ninguno'}`);
    process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
