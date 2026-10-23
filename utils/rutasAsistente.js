/**
 * Asistente de rutas: el admin le escribe en español ("añade esta entrega a
 * Aarón", "quita a Doña Lupe", "pasa a Pedro con Luis") y Claude PROPONE los
 * cambios con la herramienta `proponer_cambios`. Nada se aplica hasta que el
 * admin confirma: entonces `aplicarOperaciones` vuelve a validar contra la base
 * y ejecuta.
 *
 * La IA solo ve el estado de las rutas del día y solo puede proponer. Toda la
 * validación (que la ruta exista, que la entrega no esté cobrada, que la ruta no
 * esté cerrada) se hace aquí, no en el prompt.
 */
const Ruta = require('../models/Ruta');
const Repartidor = require('../models/Repartidor');
const { client } = require('./ai');

const MODELO = 'claude-opus-5-5';
const CAMBIO_DEFAULT = 1160;
const CAMPOS = ['emoji', 'nombre', 'direccion', 'paquete', 'extras', 'cel', 'nota', 'regalo', 'reposicion'];

const SYSTEM = `Eres el asistente de rutas de Fresh Market (Pachuca). Ayudas al admin a ajustar las rutas de reparto de un día.

En cada mensaje del admin recibes el ESTADO ACTUAL de las rutas: cada repartidor con su rutaId y sus entregas numeradas con su pedidoId. Usa siempre los ids del estado más reciente.

Para cualquier cambio usa la herramienta proponer_cambios. Tú no aplicas nada: el admin ve tu propuesta y decide. Nunca digas que algo ya quedó hecho; di que lo propones.

Operaciones:
- anadir: nueva entrega para un repartidor (por repartidorId). Si el admin pega una línea de la nota (ej. "🟢 María López - Centro, Allende #10 (1 Familiar) EXTRAS: ... Total $385 CEL. 7711234567 JUEVES Nota: ..."), sepárala en sus campos: nombre (antes del primer " - "), direccion, paquete (lo de entre paréntesis), extras, total (número), cel, nota, regalo, reposicion ("Reponer:"), emoji (🟢/🔥/🟣 si viene). No inventes datos que no estén.
- quitar: quita una entrega (rutaId + pedidoId).
- mover: pasa una entrega a otro repartidor (rutaId + pedidoId + aRepartidorId). Si ese repartidor no tiene ruta ese día, se le crea.
- editar: cambia campos de una entrega (total, direccion, nota, etc.).
- cambio: cambia el cambio inicial de una ruta.

Reglas:
- Si un nombre es ambiguo (dos clientes o repartidores que coinciden) o no lo encuentras, pregunta en vez de adivinar.
- Las entregas marcadas [COBRADA] y las rutas CERRADAS no se pueden cambiar desde aquí: dile al admin que use "Modificar ruta" en Resultados.
- Un cliente con dos pedidos tiene dos entregas; si piden quitar o mover "a fulano", incluye todas las suyas salvo que digan cuál.
- Responde breve, en español, como un compañero de trabajo.`;

const TOOLS = [
    {
        name: 'proponer_cambios',
        description: 'Propone al admin una lista de cambios a las rutas del día. El admin los revisa y decide si los aplica. Úsala siempre que el admin pida añadir, quitar, mover o editar entregas.',
        input_schema: {
            type: 'object',
            properties: {
                resumen: { type: 'string', description: 'Una línea que explique la propuesta.' },
                operaciones: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            tipo: { type: 'string', enum: ['anadir', 'quitar', 'mover', 'editar', 'cambio'] },
                            rutaId: { type: 'string', description: 'quitar, mover, editar, cambio' },
                            pedidoId: { type: 'string', description: 'quitar, mover, editar' },
                            repartidorId: { type: 'string', description: 'anadir: a quién se le añade' },
                            aRepartidorId: { type: 'string', description: 'mover: a quién pasa' },
                            entrega: {
                                type: 'object',
                                description: 'anadir: datos de la entrega nueva',
                                properties: {
                                    emoji: { type: 'string' }, nombre: { type: 'string' }, direccion: { type: 'string' },
                                    paquete: { type: 'string' }, extras: { type: 'string' }, total: { type: 'number' },
                                    cel: { type: 'string' }, nota: { type: 'string' }, regalo: { type: 'string' },
                                    reposicion: { type: 'string' },
                                },
                                required: ['nombre'],
                            },
                            cambios: {
                                type: 'object',
                                description: 'editar: solo los campos que cambian',
                                properties: {
                                    nombre: { type: 'string' }, direccion: { type: 'string' }, paquete: { type: 'string' },
                                    extras: { type: 'string' }, total: { type: 'number' }, cel: { type: 'string' },
                                    nota: { type: 'string' }, regalo: { type: 'string' }, reposicion: { type: 'string' },
                                },
                            },
                            cambioInicial: { type: 'number', description: 'cambio: nuevo cambio inicial' },
                        },
                        required: ['tipo'],
                    },
                },
            },
            required: ['resumen', 'operaciones'],
        },
    },
];

const corto = (s, n = 70) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const pesos = (n) => '$' + Number(n || 0).toLocaleString('es-MX');
const esId = (x) => /^[a-f0-9]{24}$/i.test(String(x || ''));

async function cargarDia(fecha) {
    const [rutas, repartidores] = await Promise.all([
        Ruta.find({ fechaReparto: fecha }).sort({ repartidorNombre: 1 }),
        Repartidor.find({ activo: { $ne: false } }).sort({ nombre: 1 }),
    ]);
    return { rutas, repartidores };
}

/** Texto con el estado de las rutas del día, para el modelo. */
function estadoTexto(fecha, { rutas, repartidores }) {
    const lineas = [`ESTADO ACTUAL de las rutas del ${fecha}:`, ''];
    lineas.push('Repartidores activos: ' + repartidores.map((r) => `${r.nombre} (repartidorId ${r._id})`).join('; '));
    if (!rutas.length) lineas.push('', 'Todavía no hay rutas para este día.');
    for (const r of rutas) {
        lineas.push('', `Ruta de ${r.repartidorNombre} — rutaId ${r._id} — ${r.estado === 'cerrada' ? 'CERRADA' : r.estado} — cambio ${pesos(r.cambioInicial)} — ${r.pedidos.length} entregas`);
        r.pedidos.forEach((p, i) => {
            lineas.push(`  ${i + 1}. pedidoId ${p._id} · ${p.nombre} · ${corto(p.direccion, 50)} · ${pesos(p.total)} · ${p.cel || 'sin cel'}${p.pago ? ' [COBRADA]' : ''}`);
        });
    }
    return lineas.join('\n');
}

/**
 * Revisa cada operación contra las rutas del día. Devuelve las válidas con un
 * texto legible para el admin, y los errores. No modifica nada.
 */
function validarOperaciones(ops, { rutas, repartidores }) {
    const validas = [];
    const errores = [];
    const rutaDe = (id) => rutas.find((r) => String(r._id) === String(id));
    const repDe = (id) => repartidores.find((r) => String(r._id) === String(id));

    for (const op of Array.isArray(ops) ? ops : []) {
        const t = op && op.tipo;
        if (t === 'anadir') {
            const rep = repDe(op.repartidorId);
            const e = op.entrega || {};
            if (!rep) { errores.push('Añadir: repartidor no encontrado'); continue; }
            if (!String(e.nombre || '').trim()) { errores.push('Añadir: la entrega no tiene nombre'); continue; }
            const ruta = rutas.find((r) => String(r.repartidorId) === String(rep._id));
            if (ruta && ruta.estado === 'cerrada') { errores.push(`Añadir: la ruta de ${rep.nombre} ya está cerrada`); continue; }
            const entrega = {};
            for (const k of CAMPOS) if (e[k] !== undefined && e[k] !== null && e[k] !== '') entrega[k] = String(e[k]).slice(0, 2000);
            entrega.total = Number(e.total) || 0;
            validas.push({ tipo: 'anadir', repartidorId: String(rep._id), entrega, texto: `➕ ${rep.nombre}: ${entrega.nombre} ${pesos(entrega.total)}${ruta ? '' : ' (se le crea ruta)'}` });
            continue;
        }

        const ruta = rutaDe(op.rutaId);
        if (!ruta) { errores.push(`${t}: ruta no encontrada`); continue; }
        if (ruta.estado === 'cerrada') { errores.push(`La ruta de ${ruta.repartidorNombre} ya está cerrada: usa "Modificar ruta"`); continue; }

        if (t === 'cambio') {
            const c = Number(op.cambioInicial);
            if (!Number.isFinite(c) || c < 0 || c > 100000) { errores.push('Cambio: monto inválido'); continue; }
            validas.push({ tipo: 'cambio', rutaId: String(ruta._id), cambioInicial: c, texto: `💵 ${ruta.repartidorNombre}: cambio ${pesos(ruta.cambioInicial)} → ${pesos(c)}` });
            continue;
        }

        const p = ruta.pedidos.id(op.pedidoId);
        if (!p) { errores.push(`${t}: esa entrega no está en la ruta de ${ruta.repartidorNombre}`); continue; }
        if (p.pago) { errores.push(`${p.nombre} ya tiene cobro registrado: usa "Modificar ruta"`); continue; }

        if (t === 'quitar') {
            validas.push({ tipo: 'quitar', rutaId: String(ruta._id), pedidoId: String(p._id), texto: `➖ ${ruta.repartidorNombre}: ${p.nombre} ${pesos(p.total)}` });
        } else if (t === 'mover') {
            const dest = repDe(op.aRepartidorId);
            if (!dest) { errores.push(`Mover ${p.nombre}: repartidor destino no encontrado`); continue; }
            if (String(dest._id) === String(ruta.repartidorId)) { errores.push(`${p.nombre} ya es de ${dest.nombre}`); continue; }
            const rDest = rutas.find((r) => String(r.repartidorId) === String(dest._id));
            if (rDest && rDest.estado === 'cerrada') { errores.push(`La ruta de ${dest.nombre} ya está cerrada`); continue; }
            validas.push({ tipo: 'mover', rutaId: String(ruta._id), pedidoId: String(p._id), aRepartidorId: String(dest._id), texto: `↔️ ${p.nombre}: ${ruta.repartidorNombre} → ${dest.nombre}` });
        } else if (t === 'editar') {
            const cambios = {};
            for (const k of CAMPOS) if (op.cambios && op.cambios[k] !== undefined && op.cambios[k] !== null) cambios[k] = String(op.cambios[k]).slice(0, 2000);
            if (op.cambios && op.cambios.total !== undefined) cambios.total = Number(op.cambios.total) || 0;
            if (!Object.keys(cambios).length) { errores.push(`Editar ${p.nombre}: no hay cambios`); continue; }
            const detalle = Object.entries(cambios).map(([k, v]) => `${k}: ${k === 'total' ? pesos(v) : corto(v, 40)}`).join(', ');
            validas.push({ tipo: 'editar', rutaId: String(ruta._id), pedidoId: String(p._id), cambios, texto: `✏️ ${ruta.repartidorNombre} · ${p.nombre}: ${detalle}` });
        } else {
            errores.push(`Operación desconocida: ${t}`);
        }
    }
    return { validas, errores };
}

/**
 * Un turno del chat. `messages` es el historial que devolvió el turno anterior
 * (se manda de vuelta sin tocar). `resultadoPropuesta` dice qué hizo el admin con
 * la última propuesta, si quedó una pendiente.
 */
async function conversar({ fecha, messages = [], texto, resultadoPropuesta }) {
    if (!client) {
        const err = new Error('IA desactivada en este entorno');
        err.status = 503;
        throw err;
    }
    const dia = await cargarDia(fecha);
    const historial = Array.isArray(messages) ? [...messages] : [];

    const contenido = [];
    // Si la última respuesta propuso cambios, el modelo espera su tool_result.
    const ultimo = historial[historial.length - 1];
    if (ultimo && ultimo.role === 'assistant' && Array.isArray(ultimo.content)) {
        for (const b of ultimo.content) {
            if (b.type === 'tool_use') {
                contenido.push({ type: 'tool_result', tool_use_id: b.id, content: resultadoPropuesta || 'El admin no aplicó esta propuesta.' });
            }
        }
    }
    contenido.push({ type: 'text', text: estadoTexto(fecha, dia) });
    contenido.push({ type: 'text', text: `Admin: ${texto}` });
    historial.push({ role: 'user', content: contenido });

    const resp = await client.beta.messages.create({
        model: MODELO,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        // Si un filtro de seguridad rechaza algo inocente, se reintenta en otro modelo.
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: SYSTEM,
        tools: TOOLS,
        messages: historial,
    });
    try { console.log('🤖 rutas-asistente usage:', JSON.stringify(resp.usage)); } catch (_) {}

    if (resp.stop_reason === 'refusal') {
        return { messages: historial, reply: 'No pude procesar esa instrucción. Intenta decirlo de otra forma.', propuesta: null };
    }
    historial.push({ role: 'assistant', content: resp.content });

    const reply = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const uso = resp.content.find((b) => b.type === 'tool_use' && b.name === 'proponer_cambios');
    let propuesta = null;
    if (uso) {
        const { validas, errores } = validarOperaciones(uso.input && uso.input.operaciones, dia);
        propuesta = { resumen: String((uso.input && uso.input.resumen) || ''), operaciones: validas, errores };
    }
    return { messages: historial, reply, propuesta };
}

/** Aplica operaciones ya confirmadas por el admin. Revalida contra la base. */
async function aplicarOperaciones({ fecha, operaciones, usuario }) {
    const dia = await cargarDia(fecha);
    const { validas, errores } = validarOperaciones(operaciones, dia);
    const tocadas = new Map(); // rutaId -> documento
    const rutaPorRep = (repId) => dia.rutas.find((r) => String(r.repartidorId) === String(repId));
    const repDe = (id) => dia.repartidores.find((r) => String(r._id) === String(id));

    const asegurarRuta = (repId) => {
        let r = rutaPorRep(repId);
        if (!r) {
            const rep = repDe(repId);
            r = new Ruta({ fechaReparto: fecha, repartidorId: rep._id, repartidorNombre: rep.nombre, cambioInicial: CAMBIO_DEFAULT, pedidos: [] });
            dia.rutas.push(r);
        }
        tocadas.set(String(r._id), r);
        return r;
    };

    for (const op of validas) {
        if (op.tipo === 'anadir') {
            asegurarRuta(op.repartidorId).pedidos.push(op.entrega);
            continue;
        }
        const ruta = dia.rutas.find((r) => String(r._id) === op.rutaId);
        tocadas.set(String(ruta._id), ruta);
        if (op.tipo === 'cambio') { ruta.cambioInicial = op.cambioInicial; continue; }
        const p = ruta.pedidos.id(op.pedidoId);
        if (!p) { errores.push('Una entrega ya no existe (¿se aplicó dos veces?)'); continue; }
        if (op.tipo === 'quitar') {
            p.deleteOne();
        } else if (op.tipo === 'mover') {
            const copia = p.toObject();
            delete copia._id;
            p.deleteOne();
            asegurarRuta(op.aRepartidorId).pedidos.push(copia);
        } else if (op.tipo === 'editar') {
            for (const [k, v] of Object.entries(op.cambios)) p[k] = v;
        }
    }

    // Una ruta que se queda sin entregas se borra (igual que si el admin la borrara).
    for (const r of tocadas.values()) {
        if (!r.pedidos.length) { if (!r.isNew) await Ruta.deleteOne({ _id: r._id }); } else await r.save();
    }
    console.log(`🤖 Asistente de rutas: ${validas.length} cambios aplicados al ${fecha} por ${usuario}`);
    return { aplicadas: validas.map((o) => o.texto), errores };
}

module.exports = { conversar, aplicarOperaciones, validarOperaciones, estadoTexto };
