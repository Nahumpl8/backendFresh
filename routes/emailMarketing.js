const express = require('express');
const router = express.Router();
const Clientes = require('../models/Clientes');
const EmailCampaign = require('../models/EmailCampaign');
// 👇 Solo necesitamos importar la SMART (la genérica ya no la usaremos aquí)
const { sendSmartEmail } = require('../utils/emailService'); 
const bajas = require('../utils/bajasCorreo');

// 1. OBTENER HISTORIAL DE CAMPAÑAS
router.get('/email/history', async (req, res) => {
    try {
        const campaigns = await EmailCampaign.find().sort({ createdAt: -1 }).limit(20);
        res.json(campaigns);
    } catch (err) {
        res.status(500).json(err);
    }
});

// 2. ENVIAR CORREO DE PRUEBA (ACTUALIZADO PARA SMART EMAIL)
router.post('/email/test', async (req, res) => {
    // 👇 Recibimos todos los datos visuales para probarlos
    const { email, subject, body, bannerUrl, logoUrl, resources } = req.body;
    
    try {
        // Creamos un "Usuario Falso" para que veas cómo se reemplazan las variables
        const dummyUser = { 
            email, 
            nombre: 'Administrador', // Para que veas "Hola Administrador"
            puntos: 150,             // Para probar {{puntos}}
            sellos: 4                // Para probar {{sellos}}
        };

        const opciones = { 
            bannerUrl, 
            logoUrl, 
            resources, 
            ctaText: 'Ver Botón Prueba', 
            ctaLink: '#' 
        };
        
        // Usamos la función inteligente
        await sendSmartEmail(dummyUser, subject, body, opciones);
        
        res.status(200).json({ message: 'Prueba enviada con éxito' });
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

// 3. ENVIAR CAMPAÑA MASIVA (Bulk)
router.post('/email/send-bulk', async (req, res) => {
    // 👇 Agregamos 'logoUrl' que faltaba recibir
    const { subject, body, target, ctaLink, ctaText, bannerUrl, logoUrl, specificEmails, resources } = req.body;

    try {
        console.log(`🚀 Iniciando campaña Smart: ${subject}`);

        let targets = [];

        // IMPORTANTE: Traer puntos y sellos para las fórmulas matemáticas
        const fieldsToSelect = 'nombre email puntos sellos'; 

        if (specificEmails && specificEmails.length > 0) {
            targets = await Clientes.find({ email: { $in: specificEmails } }).select(fieldsToSelect);
        } else {
            let query = { email: { $exists: true, $ne: null } };
            targets = await Clientes.find(query).select(fieldsToSelect);
        }

        // Nunca a quien pidió su baja.
        const deBaja = await bajas.correosDeBaja();
        targets = targets.filter((t) => !deBaja.has(String(t.email || '').trim().toLowerCase()));

        if (targets.length === 0) return res.status(400).json({ message: "Sin destinatarios." });

        // Guardar en historial
        const newCampaign = new EmailCampaign({
            subject, body, target: target || 'manual', recipientCount: targets.length, status: 'sending'
        });
        await newCampaign.save();

        res.json({ message: `Enviando a ${targets.length} clientes...` });

        // Opciones visuales (Agregamos logoUrl aquí también)
        const opciones = { ctaLink, ctaText, bannerUrl, logoUrl, resources };

        // ENVÍO EN SEGUNDO PLANO
        sendBulkBackground(targets, subject, body, opciones);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error iniciando campaña' });
    }
});

// 👇 ESTA ES LA ÚNICA FUNCIÓN QUE DEBE EXISTIR (Borré la duplicada vieja)
async function sendBulkBackground(users, subject, body, opciones) {
    let successCount = 0;
    
    for (const user of users) {
        if (!user.email || !user.email.includes('@')) continue;
        
        // Pausa para no saturar (Rate Limit)
        await new Promise(r => setTimeout(r, 400)); 

        try {
            // Usamos sendSmartEmail pasando el usuario completo
            const sent = await sendSmartEmail(user, subject, body, opciones);
            if (sent) successCount++;
        } catch (error) {
            console.error(`Error enviando a ${user.email}`);
        }
    }
    console.log(`✅ Campaña Smart terminada: ${successCount} enviados.`);
}

// ---------------------------------------------------------------------------
// CORREO DE LA SEMANA: imagen de promociones + despensas del catálogo
// ---------------------------------------------------------------------------
const { requireAdmin } = require('../utils/adminMiddleware');
const correoSemanal = require('../utils/correoSemanal');

const esUrl = (u) => /^https:\/\//.test(String(u || ''));
const datosSemanal = (b = {}) => {
    // Plantillas viejas traen una sola imagen en promoImg.
    const imagenes = (Array.isArray(b.imagenes) ? b.imagenes : [b.promoImg]).filter(esUrl).map(String).slice(0, 4);
    const bt = b.botones || {};
    return {
        plantilla: b.plantilla === 'promos' ? 'promos' : 'despensas',
        asunto: String(b.asunto || '').trim().slice(0, 150),
        intro: String(b.intro || '').slice(0, 1500),
        imagenes,
        aviso: String(b.aviso || '').trim().slice(0, 200),
        botones: { tienda: bt.tienda === true, whatsapp: bt.whatsapp === true, telegram: bt.telegram === true },
        conDespensas: b.conDespensas === true,
        excluirPueblos: b.excluirPueblos === true,
        soloSinPedido: b.soloSinPedido === true,
        campana: String(b.campana || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'semana',
    };
};

router.post('/semanal/vista-previa', requireAdmin, async (req, res) => {
    try { res.json(await correoSemanal.vistaPrevia(datosSemanal(req.body))); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/semanal/prueba', requireAdmin, async (req, res) => {
    const d = datosSemanal(req.body);
    const to = String(req.body?.email || '').trim();
    if (!d.asunto) return res.status(400).json({ error: 'Escribe el asunto' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'Correo de prueba inválido' });
    const ok = await correoSemanal.enviar({ ...d, soloA: to });
    res.status(ok ? 200 : 500).json(ok ? { ok: true } : { error: 'No se pudo mandar la prueba' });
});

router.post('/semanal/enviar', requireAdmin, async (req, res) => {
    const d = datosSemanal(req.body);
    if (!d.asunto) return res.status(400).json({ error: 'Escribe el asunto' });
    if (!d.imagenes.length && !d.conDespensas) return res.status(400).json({ error: 'El correo va vacío: sube una imagen o incluye las despensas' });
    try {
        const r = await correoSemanal.enviar({ ...d, creadoPor: req.admin?.usuario });
        const { campana, soloSinPedido, ...plantilla } = d;
        await guardarPlantilla(plantilla).catch(() => {});
        console.log(`📰 Correo de la semana "${d.asunto}" a ${r.total}, por ${req.admin?.usuario || 'admin'}`);
        res.json(r);
    } catch (e) { res.status(409).json({ error: e.message }); }
});

// Plantilla: lo último que se guardó o mandó, para reusarlo la siguiente semana.
const Config = require('../models/Config');
// Una por tipo: despensas (lunes) y promos (miércoles/jueves).
const clavePlantilla = (tipo) => (tipo === 'promos' ? 'correoPromosPlantilla' : 'correoSemanalPlantilla');
const guardarPlantilla = (d) => Config.updateOne({ key: clavePlantilla(d.plantilla) }, { $set: { value: JSON.stringify(d), updatedAt: new Date() } }, { upsert: true });

router.get('/semanal/plantilla', requireAdmin, async (req, res) => {
    const c = await Config.findOne({ key: clavePlantilla(req.query.tipo) }).lean();
    let plantilla = null;
    try { plantilla = c ? JSON.parse(c.value) : null; } catch (_) { /* plantilla dañada: se ignora */ }
    res.json(plantilla ? { ...plantilla, guardadaAt: c.updatedAt } : null);
});

router.put('/semanal/plantilla', requireAdmin, async (req, res) => {
    const { campana, soloSinPedido, ...d } = datosSemanal(req.body);
    await guardarPlantilla(d);
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// BAJAS: enlace del pie del correo (público, firmado) y lista en el panel
// ---------------------------------------------------------------------------
const paginaBaja = (titulo, cuerpo) => `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fresh Market</title></head>
<body style="margin:0; font-family:Arial,sans-serif; background:#f4f4f0; color:#1f2937;">
<div style="max-width:440px; margin:60px auto; background:#fff; border-radius:16px; padding:28px 22px; text-align:center;">
<div style="font-size:13px; letter-spacing:2px; font-weight:bold; color:#15803d;">FRESH MARKET</div>
<h1 style="font-size:22px; margin:14px 0 10px;">${titulo}</h1>${cuerpo}</div></body></html>`;
const escHtml = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Abrir el enlace solo pregunta (los antivirus abren los enlaces solos).
router.get('/baja', (req, res) => {
    const { e, f } = req.query;
    if (!bajas.firmaValida(e, f)) return res.status(400).send(paginaBaja('Enlace no válido', '<p>Escríbenos por WhatsApp al 771 234 6620 y te damos de baja.</p>'));
    res.send(paginaBaja('¿Ya no quieres recibir nuestros correos?',
        `<p style="color:#4b5563;">Dejaremos de mandar promociones y encuestas a <b>${escHtml(e)}</b>.</p>
        <form method="POST" action=""><button style="margin-top:12px; background:#15803d; color:#fff; border:none; padding:14px 26px; border-radius:999px; font-size:16px; font-weight:bold; cursor:pointer;">Sí, darme de baja</button></form>`));
});

// POST: el botón de la página y el "darse de baja" de Gmail/Outlook (un clic).
router.post('/baja', express.urlencoded({ extended: false }), async (req, res) => {
    const { e, f } = req.query;
    if (!bajas.firmaValida(e, f)) return res.status(400).send(paginaBaja('Enlace no válido', '<p>Escríbenos por WhatsApp al 771 234 6620 y te damos de baja.</p>'));
    await bajas.darDeBaja(e, 'enlace');
    res.send(paginaBaja('Listo, ya no te mandaremos correos', '<p style="color:#4b5563;">Si cambias de opinión, escríbenos por WhatsApp al 771 234 6620. ¡Gracias por ser cliente de Fresh Market! 💚</p>'));
});

router.get('/semanal/bajas', requireAdmin, async (req, res) => res.json(await bajas.listar()));
router.post('/semanal/bajas', requireAdmin, async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Correo inválido' });
    await bajas.darDeBaja(email, 'panel', req.admin?.nombre || req.admin?.usuario);
    res.json({ ok: true });
});
router.delete('/semanal/bajas/:email', requireAdmin, async (req, res) => {
    await bajas.reactivar(req.params.email);
    res.json({ ok: true });
});

router.get('/semanal/estado', requireAdmin, async (req, res) => res.json((await correoSemanal.estado()) || null));

module.exports = router;