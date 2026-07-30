const router = require('express').Router();
const Clientes = require('../models/Clientes');
const Despensas = require('../models/Despensas');
const { askVision } = require('../utils/ai');

// Limpia un teléfono a 10 dígitos (quita lada 52), igual que el resto del backend.
const limpiarTel = (t) => String(t || '').replace(/\D/g, '').replace(/^52/, '');

const SYSTEM_PARSE_PEDIDO = `Eres el asistente de captura de pedidos de "Fresh Market", tienda de despensas y abarrotes a domicilio en Pachuca, México.
Tu trabajo: leer capturas de conversaciones de WhatsApp y/o texto de un operador y extraer el/los pedidos en el JSON indicado.

REGLAS DEL NEGOCIO (importantes para partir bien el pedido):
- Una DESPENSA es un paquete a precio fijo. El cliente puede hacer HASTA 3 CAMBIOS: quitar un
  producto que trae el paquete y poner otro en su lugar. Regístralos en "cambios" como
  {quita, pone}. Los cambios NO bajan el precio: la despensa siempre cuesta al menos su precio base.
- Si el cliente pide la despensa Y ADEMÁS productos extra (más allá de los 3 cambios), esos
  extras van en un pedido APARTE de tipo "pedido" (personalizado, sin despensa, solo extras).
  En ese caso devuelve DOS entradas en "pedidos": una tipo "despensa" (con sus "cambios") y otra
  tipo "pedido" (con los extras en "productos").
- Si el cliente NO pide despensa, solo productos, es un único pedido tipo "pedido".
- MÍNIMO: un pedido de extras (tipo "pedido") normalmente debe sumar al menos $320. Si el mismo
  cliente también lleva una despensa (o el total entre sus pedidos ya cubre el mínimo), la regla
  se cumple. Si un pedido de extras queda por debajo de $320 y NO hay otra despensa/pedido que lo
  cubra, pon "alertaMinimo": true y en "aviso" escribe algo como "No llega a $320: preguntar al
  admin si se cobra envío extra".

CAMPOS:
- Una conversación/imagen puede traer VARIOS clientes/pedidos. Devuélvelos todos en "pedidos".
- "tipo": "despensa" o "pedido".
- "despensa": nombre EXACTO de la despensa (de la lista que te doy) si aplica; si no, "".
- "despensaQuantity": cuántas de esa despensa (normalmente 1); 0 si es tipo "pedido".
- "cambios": swaps dentro de la despensa (máx 3). Si no hay, arreglo vacío.
- "productos": extras/artículos sueltos (nombre + cantidad). Si no hay, arreglo vacío.
- "clienteNombre","telefono","direccion","colonia": del texto o imagen si aparecen. Lo que no esté, "".
- "fecha": día/fecha de entrega si la mencionan; si no, "".
- "total": total en pesos si aparece; si no, 0.
- "nota": indicaciones especiales (sin timbre, tocar el portón, etc.).
- "alertaMinimo"/"aviso": según la regla de mínimo de arriba.
- "confianza": "alta" | "media" | "baja".
- NO inventes datos. Lo que no esté, vacío/0. El operador revisa y completa.`;

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
                    tipo: { type: 'string' }, // "despensa" | "pedido"
                    clienteNombre: { type: 'string' },
                    telefono: { type: 'string' },
                    direccion: { type: 'string' },
                    colonia: { type: 'string' },
                    despensa: { type: 'string' },
                    despensaQuantity: { type: 'number' },
                    cambios: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                quita: { type: 'string' },
                                pone: { type: 'string' },
                            },
                            required: ['quita', 'pone'],
                        },
                    },
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
                    alertaMinimo: { type: 'boolean' },
                    aviso: { type: 'string' },
                    confianza: { type: 'string' },
                },
                required: [
                    'tipo', 'clienteNombre', 'telefono', 'direccion', 'colonia', 'despensa',
                    'despensaQuantity', 'cambios', 'productos', 'nota', 'fecha', 'total',
                    'alertaMinimo', 'aviso', 'confianza',
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
