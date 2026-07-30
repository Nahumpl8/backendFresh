const router = require('express').Router();
const axios = require('axios');
const Clientes = require('../models/Clientes');
const Despensas = require('../models/Despensas');
const { askVision, client } = require('../utils/ai');

// Nombres/precios reales de las despensas para inyectar en los prompts.
async function getDespensasCtx() {
    try {
        const despensas = await Despensas.find({ showInWeb: { $ne: false } }).select('name price');
        if (!despensas.length) return '';
        return '\n\nDespensas disponibles (usa EXACTAMENTE uno de estos nombres en "despensa"):\n'
            + despensas.map(d => `- ${d.name}${d.price ? ` ($${d.price})` : ''}`).join('\n');
    } catch (e) {
        console.warn('No se pudieron cargar despensas para el prompt:', e.message);
        return '';
    }
}

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
- MÍNIMO ($320 por día): el mínimo aplica al TOTAL de los pedidos de un mismo cliente PARA EL
  MISMO DÍA de entrega, que debe sumar al menos $320. CUMPLEN la regla, por ejemplo: un pedido de
  $320 o más; una despensa; o DOS pedidos del mismo día de $160 cada uno (160+160 = 320). Solo si
  el total del cliente para ese día queda POR DEBAJO de $320 y no hay una despensa/otro pedido que
  lo cubra, pon "alertaMinimo": true en el/los pedidos afectados y en "aviso" escribe algo como
  "El total del día no llega a $320: preguntar al admin si se cobra envío extra". Si el total del
  día sí llega (aunque sea con 2 pedidos de $160), NO pongas alerta.

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

        const despensasCtx = await getDespensasCtx();

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

// ============================================================================
// CHAT DE PEDIDOS (agente conversacional con herramientas) — crea pedidos en la base
// ============================================================================
const SYSTEM_CHAT = `Eres el asistente de captura de pedidos POR CHAT de "Fresh Market" (Pachuca, México).
Un OPERADOR (admin) te describe pedidos en lenguaje natural (a veces con imágenes) y tú los REGISTRAS en la base usando tus herramientas.

FLUJO:
1. Identifica al cliente con buscar_cliente (por teléfono si lo dan; si no, por nombre).
2. Si NO existe, ofrece crearlo con crear_cliente (pide nombre, teléfono y dirección si faltan).
3. Si el cliente tiene VARIAS direcciones, pregunta al operador a cuál se entrega.
4. Si falta un dato del pedido (fecha de entrega, despensa, total, precios de extras, etc.), PREGÚNTALO. No inventes datos ni precios.
5. Antes de crear, muestra un RESUMEN claro (cliente, dirección, despensa/cambios, extras, envío, total, fecha) y pide CONFIRMACIÓN explícita ("¿lo registro?").
6. SOLO tras el "sí" del operador, llama crear_pedido (una vez por cada pedido) con confirmado=true.
7. Al terminar di "✅ Pedido registrado" con el/los id y pregunta "¿Ingresar otro?".

REGLAS DEL NEGOCIO:
- Una DESPENSA es un paquete a precio fijo con HASTA 3 CAMBIOS (quita un producto, pon otro). Los cambios NO bajan el precio. Manda los "quita" en deletedProducts y los "pone" en newProducts.
- Despensa + extras (más allá de los cambios) = DOS pedidos: uno con la despensa y otro tipo "pedido" (despensa "" y despensaQuantity 0) con los extras en newProducts.
- Solo productos, sin despensa = un pedido con despensa "".
- MÍNIMO $320 por día: el total del cliente para el mismo día debe sumar >= $320. Cumplen: un pedido de $320+, una despensa, o 2 pedidos del mismo día de $160 c/u. Si el total del día NO llega a $320 y no hay despensa que lo cubra, AVISA al operador y pregunta si se cobra envío extra antes de registrar.
- El "total" de cada pedido es obligatorio: úsalo del precio de la despensa (te doy la lista con precios) + precios de extras que te dé el operador. Si no tienes un precio, pídelo.

Sé breve y claro. Responde en español. Nunca registres un pedido sin confirmación explícita.`;

const TOOLS = [
    {
        name: 'buscar_cliente',
        description: 'Busca un cliente por teléfono (preferido) o nombre. Devuelve coincidencias con sus direcciones. Úsalo SIEMPRE antes de crear pedido o cliente.',
        input_schema: {
            type: 'object',
            properties: { telefono: { type: 'string' }, nombre: { type: 'string' } },
            required: [],
        },
    },
    {
        name: 'crear_cliente',
        description: 'Crea un cliente nuevo cuando no existe. Requiere nombre, teléfono y dirección.',
        input_schema: {
            type: 'object',
            properties: {
                nombre: { type: 'string' },
                telefono: { type: 'string' },
                direccion: { type: 'string' },
                gpsLink: { type: 'string' },
            },
            required: ['nombre', 'telefono', 'direccion'],
        },
    },
    {
        name: 'crear_pedido',
        description: 'Crea UN pedido en la base. Llama una vez por pedido (una para la despensa, otra para los extras si aplica). SOLO tras confirmación explícita del operador (confirmado=true).',
        input_schema: {
            type: 'object',
            properties: {
                cliente: { type: 'string', description: 'Nombre del cliente' },
                telefono: { type: 'string' },
                direccion: { type: 'string' },
                gpsLink: { type: 'string' },
                despensa: { type: 'string', description: 'Nombre exacto de la despensa, o "" si es pedido de extras' },
                despensaQuantity: { type: 'number' },
                newProducts: {
                    type: 'array',
                    description: 'Extras y los "pone" de los cambios, con precio',
                    items: { type: 'object', properties: { title: { type: 'string' }, price: { type: 'number' } }, required: ['title', 'price'] },
                },
                deletedProducts: {
                    type: 'array',
                    description: 'Los "quita" de los cambios de la despensa',
                    items: { type: 'object', properties: { nombre: { type: 'string' }, precio: { type: 'number' } }, required: ['nombre'] },
                },
                total: { type: 'number' },
                envio: { type: 'number' },
                fecha: { type: 'string' },
                nota: { type: 'string' },
                confirmado: { type: 'boolean', description: 'Debe ser true; solo tras confirmación explícita del operador' },
            },
            required: ['cliente', 'telefono', 'despensa', 'despensaQuantity', 'total', 'fecha', 'confirmado'],
        },
    },
];

async function ejecutarTool(name, input) {
    try {
        if (name === 'buscar_cliente') {
            const { telefono, nombre } = input || {};
            let clientes = [];
            const tel = limpiarTel(telefono);
            if (tel && tel.length >= 10) {
                const c = await Clientes.findOne({ telefono: { $regex: tel.slice(-10) + '$' } });
                if (c) clientes = [c];
            }
            if (!clientes.length && nombre) {
                clientes = await Clientes.find({ nombre: { $regex: nombre, $options: 'i' } }).limit(5);
            }
            return {
                encontrados: clientes.map((c) => ({
                    _id: c._id, nombre: c.nombre, telefono: c.telefono, direccion: c.direccion,
                    costoEnvio: c.costoEnvio, gratisJueves: c.gratisJueves,
                    misDirecciones: (c.misDirecciones || []).map((d) => ({
                        alias: d.alias, direccion: d.direccion, costoEnvio: d.costoEnvio, gratisJueves: d.gratisJueves,
                    })),
                })),
            };
        }
        if (name === 'crear_cliente') {
            const nuevo = new Clientes({
                nombre: input.nombre,
                telefono: limpiarTel(input.telefono),
                direccion: input.direccion,
                gpsLink: input.gpsLink || '',
                misDirecciones: [{ alias: 'Dirección Principal', direccion: input.direccion, gpsLink: input.gpsLink || '' }],
            });
            const saved = await nuevo.save();
            return { ok: true, _id: saved._id, nombre: saved.nombre, telefono: saved.telefono, costoEnvio: saved.costoEnvio, gratisJueves: saved.gratisJueves };
        }
        if (name === 'crear_pedido') {
            if (!input.confirmado) return { ok: false, error: 'No confirmado por el operador.' };
            const payload = {
                cliente: input.cliente,
                telefono: limpiarTel(input.telefono),
                direccion: input.direccion || '',
                gpsLink: input.gpsLink || '',
                despensa: input.despensa || '',
                despensaQuantity: input.despensaQuantity || 0,
                newProducts: input.newProducts || [],
                deletedProducts: input.deletedProducts || [],
                total: input.total || 0,
                envio: input.envio || 0,
                fecha: input.fecha || '',
                nota: input.nota || '',
            };
            const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
            const { data } = await axios.post(`${base}/api/pedidos/new`, payload);
            return { ok: true, pedidoId: (data && data.pedido && data.pedido._id) || null };
        }
        return { error: 'Herramienta desconocida: ' + name };
    } catch (e) {
        console.error('❌ tool error', name, e.message);
        return { ok: false, error: e.message };
    }
}

// POST /api/ai/chat-pedido  { messages?: [...anthropic], userText?: string, images?: [{dataBase64,mediaType}] }
router.post('/chat-pedido', async (req, res) => {
    try {
        const { messages = [], userText = '', images = [] } = req.body || {};
        const apiMessages = Array.isArray(messages) ? [...messages] : [];

        const userContent = [];
        for (const img of images) {
            if (img && img.dataBase64) {
                userContent.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.dataBase64 } });
            }
        }
        if (userText) userContent.push({ type: 'text', text: userText });
        if (userContent.length) apiMessages.push({ role: 'user', content: userContent });
        if (!apiMessages.length) return res.status(400).json({ error: 'Sin mensaje.' });

        const system = SYSTEM_CHAT + (await getDespensasCtx());

        let guard = 0;
        while (guard++ < 8) {
            const resp = await client.messages.create({
                model: 'claude-sonnet-5',
                max_tokens: 4000,
                system,
                tools: TOOLS,
                messages: apiMessages,
            });
            try { console.log('🤖 chat usage:', JSON.stringify(resp.usage)); } catch (_) {}
            apiMessages.push({ role: 'assistant', content: resp.content });
            if (resp.stop_reason !== 'tool_use') break;

            const results = [];
            for (const b of resp.content) {
                if (b.type === 'tool_use') {
                    const r = await ejecutarTool(b.name, b.input);
                    results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(r) });
                }
            }
            apiMessages.push({ role: 'user', content: results });
        }

        const last = apiMessages[apiMessages.length - 1] || {};
        const reply = (last.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        res.status(200).json({ messages: apiMessages, reply });
    } catch (err) {
        console.error('❌ chat-pedido error:', err);
        res.status(500).json({ error: err.message || 'Error en el chat de pedidos' });
    }
});

module.exports = router;
