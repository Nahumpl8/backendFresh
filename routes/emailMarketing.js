const router = require('express').Router();
const Clientes = require('../models/Clientes');
const EmailCampaign = require('../models/EmailCampaign');
// 👇 Solo necesitamos importar la SMART (la genérica ya no la usaremos aquí)
const { sendSmartEmail } = require('../utils/emailService'); 

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

const datosSemanal = (b = {}) => ({
    asunto: String(b.asunto || '').trim().slice(0, 150),
    intro: String(b.intro || '').slice(0, 1500),
    promoImg: /^https:\/\//.test(String(b.promoImg || '')) ? String(b.promoImg) : '',
    conDespensas: b.conDespensas !== false,
    excluirPueblos: b.excluirPueblos === true,
    campana: String(b.campana || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'semana',
});

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
    if (!d.promoImg && !d.conDespensas) return res.status(400).json({ error: 'El correo va vacío: sube la imagen o incluye las despensas' });
    try {
        const r = await correoSemanal.enviar(d);
        const { campana, ...plantilla } = d;
        await guardarPlantilla(plantilla).catch(() => {});
        console.log(`📰 Correo de la semana "${d.asunto}" a ${r.total}, por ${req.admin?.usuario || 'admin'}`);
        res.json(r);
    } catch (e) { res.status(409).json({ error: e.message }); }
});

// Plantilla: lo último que se guardó o mandó, para reusarlo la siguiente semana.
const Config = require('../models/Config');
const CLAVE_PLANTILLA = 'correoSemanalPlantilla';
const guardarPlantilla = (d) => Config.updateOne({ key: CLAVE_PLANTILLA }, { $set: { value: JSON.stringify(d), updatedAt: new Date() } }, { upsert: true });

router.get('/semanal/plantilla', requireAdmin, async (req, res) => {
    const c = await Config.findOne({ key: CLAVE_PLANTILLA }).lean();
    let plantilla = null;
    try { plantilla = c ? JSON.parse(c.value) : null; } catch (_) { /* plantilla dañada: se ignora */ }
    res.json(plantilla ? { ...plantilla, guardadaAt: c.updatedAt } : null);
});

router.put('/semanal/plantilla', requireAdmin, async (req, res) => {
    const { campana, ...d } = datosSemanal(req.body);
    await guardarPlantilla(d);
    res.json({ ok: true });
});

router.get('/semanal/estado', requireAdmin, (req, res) => res.json(correoSemanal.estado() || null));

module.exports = router;