const router = require('express').Router();
const Clientes = require('../models/Clientes');
const Despensas = require('../models/Despensas');
const { askVision } = require('../utils/ai');

// Limpia un teléfono a 10 dígitos (quita lada 52), igual que el resto del backend.
const limpiarTel = (t) => String(t || '').replace(/\D/g, '').replace(/^52/, '');

const SYSTEM_PARSE_PEDIDO = `Eres el asistente de captura de pedidos de "Fresh Market", una tienda de despensas y abarrotes a domicilio en Pachuca, México.
Tu trabajo: leer capturas de conversaciones de WhatsApp y/o texto que te pasa un operador, y extraer el/los pedidos en el formato JSON indicado.

Reglas:
- Una conversación/imagen puede contener VARIOS pedidos (de distintos clientes o fechas). Devuélvelos todos en "pedidos".
- "despensa" es el nombre del paquete de despensa que pide el cliente si lo menciona (ej. "Especial", "Familiar"); si solo pide productos sueltos, deja "despensa" en "" y pon "despensaQuantity" en 0.
- "productos" son los artículos sueltos o extras que pide (nombre + cantidad). Si no hay, arreglo vacío.
- "clienteNombre", "telefono", "direccion", "colonia": extráelos del texto o la imagen si aparecen (ej. "Dolores Pedraza de la colonia Lindavista"). Lo que no encuentres, déjalo en "".
- "fecha": si mencionan un día/fecha de entrega, ponla tal cual; si no, "".
- "total": si aparece un total en pesos, ponlo como número; si no, 0.
- "nota": cualquier indicación especial (sin timbre, tocar el portón, etc.).
- "confianza": "alta" | "media" | "baja" según qué tan claro estaba el pedido.
- NO inventes datos. Si algo no está, déjalo vacío/0. El operador revisará y completará.`;

const PEDIDO_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        pedidos: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    clienteNombre: { type: 'string' },
                    telefono: { type: 'string' },
                    direccion: { type: 'string' },
                    colonia: { type: 'string' },
                    despensa: { type: 'string' },
                    despensaQuantity: { type: 'number' },
                    productos: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                nombre: { type: 'string' },
                                cantidad: { type: 'number' },
                            },
                            required: ['nombre', 'cantidad'],
                        },
                    },
                    nota: { type: 'string' },
                    fecha: { type: 'string' },
                    total: { type: 'number' },
                    confianza: { type: 'string' },
                },
                required: [
                    'clienteNombre', 'telefono', 'direccion', 'colonia', 'despensa',
                    'despensaQuantity', 'productos', 'nota', 'fecha', 'total', 'confianza',
                ],
            },
        },
    },
    required: ['pedidos'],
};

// POST /api/ai/parse-pedido  { images?: [{dataBase64, mediaType}], texto?, telefono? }
router.post('/parse-pedido', async (req, res) => {
    try {
        const { images = [], texto = '', telefono = '' } = req.body || {};
        if ((!images || images.length === 0) && !String(texto).trim()) {
            return res.status(400).json({ error: 'Manda al menos una imagen o texto del pedido.' });
        }

        // Cargar las despensas reales de la base para que la IA use el nombre exacto.
        let despensasCtx = '';
        try {
            const despensas = await Despensas.find({ showInWeb: { $ne: false } }).select('name price');
            if (despensas.length) {
                despensasCtx = '\n\nDespensas disponibles (usa EXACTAMENTE uno de estos nombres en "despensa" si el cliente pide una despensa):\n'
                    + despensas.map(d => `- ${d.name}${d.price ? ` ($${d.price})` : ''}`).join('\n');
            }
        } catch (e) { console.warn('No se pudieron cargar despensas para el prompt:', e.message); }

        const userText = [
            texto ? `Contexto del operador: ${texto}` : '',
            telefono ? `El operador dice que el cliente es el teléfono: ${telefono}` : '',
            'Extrae el/los pedidos en el JSON del schema.',
        ].filter(Boolean).join('\n');

        const { data, usage } = await askVision({
            images,
            text: userText,
            systemPrompt: SYSTEM_PARSE_PEDIDO + despensasCtx,
            schema: PEDIDO_SCHEMA,
        });

        const pedidos = (data && Array.isArray(data.pedidos)) ? data.pedidos : [];

        // Enriquecer cada pedido con la búsqueda del cliente por teléfono.
        const telOperador = limpiarTel(telefono);
        const enriquecidos = [];
        for (const p of pedidos) {
            const tel = telOperador || limpiarTel(p.telefono);
            let clienteEncontrado = false;
            let cliente = null;
            if (tel && tel.length >= 10) {
                cliente = await Clientes.findOne({ telefono: { $regex: tel.slice(-10) + '$' } });
                clienteEncontrado = !!cliente;
            }
            enriquecidos.push({
                ...p,
                telefono: tel || p.telefono || '',
                clienteEncontrado,
                cliente, // doc completo si existe, o null
            });
        }

        res.status(200).json({ pedidos: enriquecidos, usage });
    } catch (err) {
        console.error('❌ parse-pedido error:', err);
        res.status(500).json({ error: err.message || 'Error procesando el pedido' });
    }
});

module.exports = router;
