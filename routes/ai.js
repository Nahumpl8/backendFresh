const router = require('express').Router();
const axios = require('axios');
const Clientes = require('../models/Clientes');
const Despensas = require('../models/Despensas');
const Product = require('../models/Product');
const { askVision, client } = require('../utils/ai');

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

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
- MÍNIMO ($320, SOLO personalizados): una DESPENSA cumple SIEMPRE, sin importar su precio (NO le
  pongas alertaMinimo). El mínimo de $320 aplica solo a pedidos PERSONALIZADOS (tipo "pedido", sin
  despensa). Un personalizado debe sumar >= $320; 2 personalizados del mismo día de $160 c/u
  cumplen (160+160=320). Solo si un personalizado queda por debajo de $320 y no hay otro
  pedido/despensa del día que lo cubra, pon "alertaMinimo": true con "aviso" tipo "El personalizado
  no llega a $320: preguntar al admin si se cobra envío extra". Nunca alertes por una despensa.

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
7. Al terminar di "✅ Pedido registrado" y pregunta "¿Ingresar otro?". NO escribas el mensaje
   de confirmación de WhatsApp en tu respuesta: el sistema le muestra al operador un botón para
   copiarlo y enviarlo al cliente automáticamente.

REGLAS DEL NEGOCIO:
- Una DESPENSA es un paquete a precio fijo con HASTA 3 CAMBIOS (quita un producto, pon otro). Los cambios NO bajan el precio. Manda los "quita" en deletedProducts y los "pone" en newProducts.
- Despensa + extras (más allá de los cambios) = DOS pedidos: uno con la despensa y otro tipo "pedido" (despensa "" y despensaQuantity 0) con los extras en newProducts.
- Solo productos, sin despensa = un pedido con despensa "".
- MÍNIMO $320 (SOLO pedidos personalizados): una DESPENSA cumple SIEMPRE, sin importar su precio — NO le apliques mínimo. El mínimo de $320 aplica únicamente a pedidos PERSONALIZADOS (tipo "pedido", sin despensa). Un personalizado debe llegar a $320; si el mismo cliente hace 2 personalizados el mismo día pueden ser de $160 c/u (160+160=320). Solo si un personalizado no llega a $320 y no hay otro pedido/despensa del día que lo cubra, avisa y pregunta si se cobra envío extra. NUNCA bloquees ni alertes por el monto de una despensa.
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

// Mensaje de pedido en el MISMO formato que el panel (generateOrderMessage de BuenoPedidos).
function buildMensajeWhatsApp(p) {
    const nombre = (p.cliente || '').split('-')[0].trim();
    let msg = `🟣 ${nombre} - ${p.direccion || ''}`;
    if (p.despensa) msg += ` ( ${p.despensaQuantity || ''} ${p.despensa} )`;
    if ((p.deletedProducts || []).length) {
        msg += (p.deletedProducts.map((d) => ` no ${d.nombre || d}`).join(',')) + ',';
    }
    if ((p.newProducts || []).length) {
        msg += ` EXTRAS:` + (p.newProducts.map((x) => ` ${x.title}`).join(',')) + ',';
    }
    if (p.regalo) msg += ` Regalo: ${p.regalo}`;
    if (p.envio) msg += ` + envío: $${p.envio}`;
    if (p.total) msg += ` Total $${p.total}`;
    if (p.telefono) msg += ` CEL. ${p.telefono}`;
    if (p.fecha) msg += ` ${String(p.fecha).split(',')[0]}`;
    if (p.nota) msg += ` Nota: ${p.nota}`;
    return msg;
}

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

            const tel = limpiarTel(input.telefono);
            // La despensa NO puede ir vacía (el modelo la exige). Si es personalizado, "Pedido".
            const despensa = (input.despensa && input.despensa.trim()) ? input.despensa.trim() : 'Pedido';
            // La dirección es obligatoria: si falta, la tomamos del cliente por teléfono.
            let direccion = (input.direccion || '').trim();
            if (!direccion && tel.length >= 10) {
                const c = await Clientes.findOne({ telefono: { $regex: tel.slice(-10) + '$' } });
                if (c) direccion = c.direccion || (c.misDirecciones && c.misDirecciones[0] && c.misDirecciones[0].direccion) || '';
            }
            if (!direccion) return { ok: false, error: 'Falta la dirección de entrega. Pregúntala al operador.' };
            if (!tel) return { ok: false, error: 'Falta el teléfono del cliente.' };

            const payload = {
                cliente: input.cliente,
                telefono: tel,
                direccion,
                gpsLink: input.gpsLink || '',
                despensa,
                despensaQuantity: (input.despensaQuantity != null ? input.despensaQuantity : (despensa === 'Pedido' ? 0 : 1)),
                newProducts: input.newProducts || [],
                deletedProducts: input.deletedProducts || [],
                total: input.total || 0,
                envio: input.envio || 0,
                fecha: input.fecha || '',
                nota: input.nota || '',
            };
            const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
            const { data } = await axios.post(`${base}/api/pedidos/new`, payload);
            return {
                ok: true,
                pedidoId: (data && data.pedido && data.pedido._id) || null,
                telefono: payload.telefono,
                mensajeWhatsApp: buildMensajeWhatsApp(payload),
            };
        }
        return { error: 'Herramienta desconocida: ' + name };
    } catch (e) {
        const detalle = e.response && e.response.data
            ? (typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data))
            : e.message;
        console.error('❌ tool error', name, detalle);
        return { ok: false, error: `Error al ${name}: ${detalle}` };
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
        const pedidosCreados = [];

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
                    let forModel = r;
                    if (b.name === 'crear_pedido' && r.ok) {
                        pedidosCreados.push({ pedidoId: r.pedidoId, telefono: r.telefono, mensajeWhatsApp: r.mensajeWhatsApp });
                        // Al modelo le basta el ok+id (no reenviamos el mensaje para no gastar tokens ni que lo repita).
                        forModel = { ok: true, pedidoId: r.pedidoId };
                    }
                    results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(forModel) });
                }
            }
            apiMessages.push({ role: 'user', content: results });
        }

        const last = apiMessages[apiMessages.length - 1] || {};
        const reply = (last.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        res.status(200).json({ messages: apiMessages, reply, pedidosCreados });
    } catch (err) {
        console.error('❌ chat-pedido error:', err);
        res.status(500).json({ error: err.message || 'Error en el chat de pedidos' });
    }
});

// ============================================================================
// PREFILL DE PEDIDO — la IA arma el pedido emparejado con el catálogo (precios
// reales) para LLENAR el formulario de /pedidos/nuevopedido. El admin revisa y
// da "Registrar" (reusa toda la lógica del formulario).
// ============================================================================

// Contexto (despensas con productos, catálogo, fechas) para los prompts.
async function getContextoPedido() {
    const despensas = await Despensas.find({ showInWeb: { $ne: false } })
        .populate('products.productId', 'title nombreSinUnidades price');
    // TODOS los productos (sin filtrar por showInWeb/inStock): los cupones y promos
    // suelen estar ocultos de la web pero SÍ se pueden agregar a un pedido manual.
    const catalogo = await Product.find({}).select('title price');
    const AppConfig = require('../models/AppConfig');
    const cfg = await AppConfig.findOne({ key: 'main' });
    const fechasList = (cfg && cfg.fechas) || [];

    const despensasCtx = despensas.map((d) => {
        const prods = (d.products || [])
            .map((p) => (p.productId ? (p.productId.nombreSinUnidades || p.productId.title) : null))
            .filter(Boolean);
        return `Despensa "${d.name}" ($${d.price}) — productos: ${prods.join(', ')}`;
    }).join('\n');
    const catalogoCtx = catalogo.map((p) => `${p._id}|${p.title}|$${p.price}`).join('\n');
    const fechasCtx = fechasList.length
        ? `\n\n== FECHAS DE ENTREGA DISPONIBLES (usa EXACTAMENTE una de estas cadenas) ==\n${fechasList.join('\n')}`
        : '';
    const ctx = `\n\n== DESPENSAS ==\n${despensasCtx}\n\n== CATÁLOGO (id|producto|precio) ==\n${catalogoCtx}${fechasCtx}`;
    return { despensas, catalogo, fechasList, ctx };
}

// Resuelve un pedido (nombres/ids -> productos reales con precios) y calcula total.
// data: { despensaName, despensaQuantity, quita:[], extras:[{productId,cantidad}], fecha, clienteNombre, telefono, direccion, colonia, aviso }
async function resolverPedido(data, { despensas, fechasList }, telefonoOperador) {
    let despensa = null, despensaProducts = [], deletedProducts = [];
    if (data.despensaName) {
        despensa = despensas.find((d) => norm(d.name) === norm(data.despensaName))
            || despensas.find((d) => norm(d.name).includes(norm(data.despensaName)));
        if (despensa) {
            despensaProducts = (despensa.products || []).map((p, i) => ({
                id: (p.productId && p.productId._id) ? String(p.productId._id) : `item-${i}`,
                nombre: p.productId ? (p.productId.nombreSinUnidades || p.productId.title) : '',
                precio: (p.productId && p.productId.price) || 0,
                cantidad: p.cantidad, unidad: p.unidad,
            }));
            deletedProducts = (data.quita || [])
                .map((q) => despensaProducts.find((dp) => norm(dp.nombre) === norm(q) || norm(dp.nombre).includes(norm(q))))
                .filter(Boolean);
        }
    }

    const newProducts = [];
    const noEncontrados = [];
    for (const e of (data.extras || [])) {
        let prod = null;
        try { prod = await Product.findById(e.productId).select('title price'); } catch (_) {}
        if (prod) newProducts.push({ _id: String(prod._id), title: prod.title, price: prod.price || 0 });
        else noEncontrados.push(e.productId);
    }

    let fechaFinal = data.fecha || '';
    if (fechaFinal && fechasList.length) {
        const exacta = fechasList.find((f) => norm(f) === norm(fechaFinal));
        if (exacta) fechaFinal = exacta;
        else {
            const dia = norm(fechaFinal).split(/[ ,]/)[0];
            const porDia = fechasList.find((f) => norm(f).startsWith(dia));
            if (porDia) fechaFinal = porDia;
        }
    }

    const qty = data.despensaQuantity != null ? data.despensaQuantity : (despensa ? 1 : 0);
    const totalDespensa = despensa ? (despensa.price || 0) * (qty || 1) : 0;
    const totalQuita = deletedProducts.reduce((a, p) => a + (p.precio || 0), 0);
    const totalExtras = newProducts.reduce((a, p) => a + (p.price || 0), 0);
    const total = Math.max(0, totalDespensa - totalQuita + totalExtras);

    const tel = limpiarTel(telefonoOperador) || limpiarTel(data.telefono);
    let cliente = null;
    if (tel && tel.length >= 10) cliente = await Clientes.findOne({ telefono: { $regex: tel.slice(-10) + '$' } });

    return {
        clienteEncontrado: !!cliente,
        cliente,
        clienteNombre: data.clienteNombre || '',
        telefono: tel || data.telefono || '',
        direccion: data.direccion || '',
        colonia: data.colonia || '',
        despensa: despensa ? { _id: String(despensa._id), name: despensa.name, price: despensa.price } : null,
        despensaProducts,
        despensaQuantity: qty,
        deletedProducts,
        newProducts,
        noEncontrados,
        fecha: fechaFinal,
        total,
        aviso: data.aviso || '',
    };
}

// ---- One-shot (cuadro único): extrae y devuelve el prefill ----
const SYSTEM_PREFILL = `Eres el asistente de captura de Fresh Market (Pachuca). Lee el pedido (texto y/o imagen) y devuélvelo en el JSON del schema, EMPAREJADO con el catálogo. despensaName exacto de la lista (o "" si es personalizado). quita: nombres exactos de productos de esa despensa. extras: usa el "id" exacto del catálogo. NO inventes; lo que no esté, vacío. MÍNIMO $320 solo para personalizados.`;
const PREFILL_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: {
        clienteNombre: { type: 'string' }, telefono: { type: 'string' }, direccion: { type: 'string' }, colonia: { type: 'string' },
        despensaName: { type: 'string' }, despensaQuantity: { type: 'number' },
        quita: { type: 'array', items: { type: 'string' } },
        extras: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { productId: { type: 'string' }, cantidad: { type: 'number' } }, required: ['productId', 'cantidad'] } },
        fecha: { type: 'string' }, esPersonalizado: { type: 'boolean' }, aviso: { type: 'string' },
    },
    required: ['clienteNombre', 'telefono', 'direccion', 'colonia', 'despensaName', 'despensaQuantity', 'quita', 'extras', 'fecha', 'esPersonalizado', 'aviso'],
};

router.post('/prefill-pedido', async (req, res) => {
    try {
        const { texto = '', images = [], telefono = '' } = req.body || {};
        if ((!images || images.length === 0) && !String(texto).trim()) return res.status(400).json({ error: 'Manda texto o imagen del pedido.' });

        const contexto = await getContextoPedido();
        const system = SYSTEM_PREFILL + contexto.ctx;
        const userText = [texto ? `Pedido del operador: ${texto}` : '', telefono ? `Teléfono del cliente: ${telefono}` : '', 'Devuelve el pedido emparejado.'].filter(Boolean).join('\n');
        const contentBlocks = [];
        for (const img of images) if (img && img.dataBase64) contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.dataBase64 } });
        contentBlocks.push({ type: 'text', text: userText });

        const resp = await client.messages.create({ model: 'claude-sonnet-5', max_tokens: 4000, system, output_config: { format: { type: 'json_schema', schema: PREFILL_SCHEMA } }, messages: [{ role: 'user', content: contentBlocks }] });
        try { console.log('🤖 prefill usage:', JSON.stringify(resp.usage)); } catch (_) {}
        if (resp.stop_reason === 'refusal') return res.status(200).json({ error: 'La IA rechazó la solicitud.' });
        const txt = (resp.content || []).find((b) => b.type === 'text');
        let data; try { data = JSON.parse(txt ? txt.text : '{}'); } catch (e) { return res.status(500).json({ error: 'Respuesta IA inválida' }); }

        const resuelto = await resolverPedido(data, contexto, telefono);
        res.status(200).json({ ...resuelto, usage: resp.usage });
    } catch (err) {
        console.error('❌ prefill-pedido error:', err);
        res.status(500).json({ error: err.message || 'Error leyendo el pedido' });
    }
});

// ---- Conversacional: la IA explica, pregunta si hay duda, y llena el formulario ----
const SYSTEM_CHAT_PREFILL = `Eres el asistente de captura de pedidos de Fresh Market (Pachuca). El OPERADOR (admin) te describe pedidos y tú LLENAS el formulario de nuevo pedido con la herramienta "prellenar_formulario". El operador revisa y da "Registrar" (tú NUNCA registras el pedido).

SÉ ESTRICTO — NO INVENTES:
- Empareja SIEMPRE contra el catálogo que te doy. Si un producto que pide el cliente coincide con MÁS DE UNO del catálogo (ej. "uva" → "uva verde" y "cupón uva roja"), o no es claro cuál es, o no existe, PREGUNTA al operador cuál es exactamente (lista las opciones). NO elijas por tu cuenta.
- Si falta un dato (fecha de entrega, cantidad, qué despensa, etc.), PREGÚNTALO.
- Usa los "id" del catálogo para los extras; los "quita" son nombres de productos de la despensa elegida.

FLUJO:
1. Identifica al cliente con buscar_cliente (por teléfono o nombre). Si tiene varias direcciones, menciónalas y pregunta a cuál.
2. Cuando tengas todo CLARO y sin ambigüedad, llama prellenar_formulario y luego EXPLICA en 2-4 líneas qué llenaste: despensa, cambios (quita/pone), extras con precio, total y fecha. Invita al operador a corregir si algo está mal.
3. Si el operador pide un cambio, ajusta y vuelve a llamar prellenar_formulario.

REGLAS: una despensa admite hasta 3 cambios (quita/pone, no baja el precio); extras van aparte; MÍNIMO $320 solo para pedidos personalizados (sin despensa), las despensas cumplen siempre. Responde en español, breve.`;

const PRELLENAR_TOOLS = [
    TOOLS.find((t) => t.name === 'buscar_cliente'),
    {
        name: 'prellenar_formulario',
        description: 'Vuelca el pedido al formulario del operador. Llámalo solo cuando NO haya ambigüedad (ya preguntaste lo dudoso). Puedes volver a llamarlo para ajustar.',
        input_schema: {
            type: 'object',
            properties: {
                clienteNombre: { type: 'string' }, telefono: { type: 'string' }, direccion: { type: 'string' }, colonia: { type: 'string' },
                despensaName: { type: 'string' }, despensaQuantity: { type: 'number' },
                quita: { type: 'array', items: { type: 'string' } },
                extras: { type: 'array', items: { type: 'object', properties: { productId: { type: 'string' }, cantidad: { type: 'number' } }, required: ['productId'] } },
                fecha: { type: 'string' }, aviso: { type: 'string' },
            },
            required: ['despensaName', 'quita', 'extras'],
        },
    },
];

router.post('/chat-prefill', async (req, res) => {
    try {
        const { messages = [], userText = '', images = [], telefono = '' } = req.body || {};
        const apiMessages = Array.isArray(messages) ? [...messages] : [];
        const userContent = [];
        for (const img of images) if (img && img.dataBase64) userContent.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.dataBase64 } });
        if (userText) userContent.push({ type: 'text', text: userText });
        if (userContent.length) apiMessages.push({ role: 'user', content: userContent });
        if (!apiMessages.length) return res.status(400).json({ error: 'Sin mensaje.' });

        const contexto = await getContextoPedido();
        const system = SYSTEM_CHAT_PREFILL + contexto.ctx;
        let prefill = null;

        let guard = 0;
        while (guard++ < 8) {
            const resp = await client.messages.create({ model: 'claude-sonnet-5', max_tokens: 4000, system, tools: PRELLENAR_TOOLS, messages: apiMessages });
            try { console.log('🤖 chat-prefill usage:', JSON.stringify(resp.usage)); } catch (_) {}
            apiMessages.push({ role: 'assistant', content: resp.content });
            if (resp.stop_reason !== 'tool_use') break;

            const results = [];
            for (const b of resp.content) {
                if (b.type !== 'tool_use') continue;
                if (b.name === 'prellenar_formulario') {
                    const resuelto = await resolverPedido(b.input, contexto, telefono || b.input.telefono);
                    prefill = resuelto;
                    const resumen = {
                        ok: true,
                        despensa: resuelto.despensa ? resuelto.despensa.name : '(personalizado)',
                        quitados: resuelto.deletedProducts.map((d) => d.nombre),
                        extras: resuelto.newProducts.map((p) => `${p.title} $${p.price}`),
                        extrasNoEncontrados: resuelto.noEncontrados,
                        total: resuelto.total,
                        fecha: resuelto.fecha,
                        clienteEncontrado: resuelto.clienteEncontrado,
                        direccion: resuelto.direccion || (resuelto.cliente && resuelto.cliente.direccion) || '',
                    };
                    results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(resumen) });
                } else {
                    const r = await ejecutarTool(b.name, b.input);
                    results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(r) });
                }
            }
            apiMessages.push({ role: 'user', content: results });
        }

        const last = apiMessages[apiMessages.length - 1] || {};
        const reply = (last.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        res.status(200).json({ messages: apiMessages, reply, prefill });
    } catch (err) {
        console.error('❌ chat-prefill error:', err);
        res.status(500).json({ error: err.message || 'Error en el chat' });
    }
});

module.exports = router;
