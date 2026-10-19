/**
 * Bot de Telegram en modo POLLING, para desarrollo local.
 *
 * En producción los updates llegan por webhook, que necesita una URL pública
 * HTTPS. En local eso obligaría a montar un túnel; con polling el bot pregunta
 * "¿hay algo nuevo?" cada pocos segundos y no hace falta nada más.
 *
 * Importante: usa el MISMO `procesarUpdate` que el webhook. Lo que se prueba
 * aquí es exactamente lo que correrá en producción.
 *
 * Uso:
 *   node scripts/telegramPoll.js
 *
 * Requiere en .env: TELEGRAM_BOT_TOKEN, MONGO_URL (de staging) y APP_ENTORNO=staging.
 * Ctrl+C para parar.
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const tg = require('../utils/telegram');
const bot = require('../utils/telegramBot');
const { esStaging } = require('../utils/entorno');

dotenv.config();

const log = (...a) => console.log(...a);

async function comprobaciones() {
    if (!tg.hayToken()) {
        console.error('🛑 Falta TELEGRAM_BOT_TOKEN en el .env');
        process.exit(1);
    }
    if (!process.env.MONGO_URL) {
        console.error('🛑 Falta MONGO_URL en el .env');
        process.exit(1);
    }

    // Guarda dura: este script escribe en la base, así que no debe tocar
    // producción ni por accidente. Mismo criterio que seedStaging.js.
    const base = String(process.env.MONGO_URL).split('?')[0].split('/').pop();
    if (!base.toLowerCase().includes('staging')) {
        console.error(`🛑 MONGO_URL apunta a "${base}", que no es una base de staging.`);
        console.error('   El polling local solo debe correr contra freshapi_staging.');
        process.exit(1);
    }

    if (!esStaging()) {
        console.warn('⚠️  APP_ENTORNO no es "staging": los correos, pushes y llamadas a');
        console.warn('    Claude NO estarían bloqueados. Añade APP_ENTORNO=staging al .env.');
    }
    return base;
}

(async () => {
    const base = await comprobaciones();

    // Se arranca el servidor completo (index.js): el agente crea los pedidos
    // llamando a POST /api/pedidos/new, igual que la tienda, así que esa ruta
    // tiene que estar escuchando. index.js también conecta Mongo.
    process.env.TELEGRAM_ENABLED = 'true';
    // Puerto propio para no chocar con otros proyectos que corran en local en el
    // 3000. El agente se llama a sí mismo en process.env.PORT, así que basta esto.
    process.env.PORT = process.env.TELEGRAM_POLL_PORT || '4600';
    require('../index.js');
    if (mongoose.connection.readyState !== 1) {
        await new Promise((ok, mal) => {
            mongoose.connection.once('open', ok);
            mongoose.connection.once('error', mal);
        });
    }
    log(`✅ Servidor local en el puerto ${process.env.PORT || 3000} · Mongo conectado a "${base}"`);

    const me = await tg.getMe();
    if (!me.ok) { console.error('🛑 Token inválido:', me.desc); process.exit(1); }
    log(`✅ Bot @${me.resultado.username} (${me.resultado.first_name})`);

    // El webhook y el polling se excluyen: mientras haya webhook registrado,
    // getUpdates devuelve error. Se quita por si quedó de una prueba anterior.
    const info = await tg.getWebhookInfo();
    if (info.ok && info.resultado.url) {
        log(`⚠️  Había un webhook en ${info.resultado.url} — lo quito para poder hacer polling`);
        await tg.deleteWebhook(false);
    }

    await tg.setMyCommands(bot.COMANDOS);
    log(`✅ ${bot.COMANDOS.length} comandos registrados`);

    // Botón «Menú»: lista de comandos con «Despensas» primero.
    const mb = await tg.setBotonMenuComandos();
    log(mb.ok ? '✅ Botón «Menú» (comandos)' : `⚠️ botón de menú: ${mb.desc}`);

    log('');
    log('─'.repeat(64));
    log(`🤖 Escuchando. Escríbele a @${me.resultado.username} desde tu Telegram.`);
    log('   Ctrl+C para parar.');
    log('─'.repeat(64));
    log('');

    let offset = 0;
    let parar = false;
    process.on('SIGINT', () => {
        log('\n👋 Parando…');
        parar = true;
    });

    while (!parar) {
        // long polling: la petición se queda abierta hasta 25 s esperando algo,
        // así no hay que machacar la API cada segundo.
        const r = await tg.getUpdates({ offset, timeout: 25 });

        if (!r.ok) {
            // 409 = hay otra instancia haciendo polling con el mismo token.
            if (/conflict/i.test(r.desc || '')) {
                console.error('🛑 Otra instancia está usando este bot. Ciérrala y vuelve a intentar.');
                break;
            }
            console.error('⚠️ getUpdates:', r.tipo, r.desc);
            await new Promise((res) => setTimeout(res, (r.esperarSegundos || 5) * 1000));
            continue;
        }

        for (const update of r.resultado) {
            offset = update.update_id + 1;
            const m = update.message || update.edited_message;
            const quien = m && m.from ? (m.from.username ? '@' + m.from.username : m.from.first_name) : '(sistema)';
            const qué = m ? (m.contact ? '[contacto]' : (m.text || '[sin texto]')) : Object.keys(update).filter(k => k !== 'update_id').join(',');
            log(`📨 ${quien}: ${String(qué).slice(0, 70)}`);
            await bot.procesarUpdate(update);
        }
    }

    await mongoose.disconnect();
    log('✅ Desconectado.');
    process.exit(0);
})().catch(async (e) => {
    console.error('❌ Error:', e);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
