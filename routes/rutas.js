const router = require('express').Router();
const Ruta = require('../models/Ruta');
const Repartidor = require('../models/Repartidor');
const { requireAdmin } = require('../utils/adminMiddleware');
const tg = require('../utils/telegram');

// YYYY-MM-DD en hora de México. El servidor corre en UTC: con la hora local del
// servidor, después de las 6 pm ya era "mañana" y el repartidor no encontraba su ruta.
const hoyStr = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

// El repartidor puede corregir su cuenta cerrada solo el mismo día de la ruta.
const puedeCorregir = (ruta) => ruta.estado === 'cerrada' && ruta.fechaReparto === hoyStr();

// Campos de una entrega que puede editar el admin. Lo que captura el repartidor
// (pago, descuento, notaRepartidor, pagoDetalle) se conserva.
const CAMPOS_ENTREGA = ['raw', 'emoji', 'nombre', 'direccion', 'paquete', 'extras', 'cel', 'nota', 'regalo', 'reposicion', 'diaDetectado'];

// Máximo 10 gastos, concepto corto y monto positivo.
const limpiarGastos = (gastos) => (Array.isArray(gastos) ? gastos : [])
    .map((g) => ({
        concepto: String((g && g.concepto) || '').trim().slice(0, 60) || 'Gasto',
        monto: Math.round(Number(g && g.monto) * 100) / 100,
    }))
    .filter((g) => Number.isFinite(g.monto) && g.monto > 0 && g.monto <= 100000)
    .slice(0, 10);

const calcularTotales = (pedidos, gastos = []) => {
    const t = { efectivo: 0, tarjeta: 0, transferencia: 0, gastos: 0, cancelados: [] };
    for (const g of gastos) t.gastos += g.monto || 0;
    for (const p of pedidos) {
        const monto = (p.total || 0) - (p.descuento || 0);
        if (p.pago === 'efectivo') t.efectivo += monto;
        else if (p.pago === 'tarjeta') t.tarjeta += monto;
        else if (p.pago === 'transferencia') t.transferencia += monto;
        else if (p.pago === 'combinado' && p.pagoDetalle) {
            t.efectivo += p.pagoDetalle.efectivo || 0;
            t.tarjeta += p.pagoDetalle.tarjeta || 0;
            t.transferencia += p.pagoDetalle.transferencia || 0;
        } else if (p.pago === 'cancelado') {
            t.cancelados.push(p.nombre);
        }
    }
    return t;
};

// Foto de lo que reportó el repartidor, para comparar en una corrección.
// Se copia con JSON para que no quede ligada al documento de Mongoose.
const fotoCuenta = (ruta) => JSON.parse(JSON.stringify({
    at: new Date(),
    totales: ruta.totales,
    gastos: ruta.gastos.map((g) => ({ concepto: g.concepto, monto: g.monto })),
    pagos: ruta.pedidos.map((p) => ({
        pedidoId: p._id,
        nombre: p.nombre,
        pago: p.pago || null,
        descuento: p.descuento || 0,
        pagoDetalle: p.pagoDetalle || null,
    })),
}));

const describirPago = (p) => {
    if (!p || !p.pago) return 'sin capturar';
    let txt = p.pago;
    if (p.pago === 'combinado' && p.pagoDetalle) {
        const d = p.pagoDetalle;
        txt += ` (${['efectivo', 'tarjeta', 'transferencia'].filter((k) => d[k]).map((k) => `${k} $${d[k]}`).join(', ')})`;
    }
    if (p.descuento) txt += `, desc. $${p.descuento}`;
    return txt;
};

/** Lista legible de lo que cambió entre la cuenta anterior y la nueva. */
const cambiosCuenta = (antes, despues) => {
    const cambios = [];
    for (const d of despues.pagos) {
        const a = antes.pagos.find((x) => String(x.pedidoId) === String(d.pedidoId));
        const txtA = describirPago(a);
        const txtD = describirPago(d);
        if (txtA !== txtD) cambios.push(`${d.nombre}: ${txtA} → ${txtD}`);
    }
    if ((antes.totales.gastos || 0) !== (despues.totales.gastos || 0)) {
        cambios.push(`Gastos: $${antes.totales.gastos || 0} → $${despues.totales.gastos || 0}`);
    }
    return cambios;
};

const pesos = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 });

/** Avisa por Telegram a los admins (TELEGRAM_ADMIN_IDS) que se cerró una ruta. */
async function avisarCierreTelegram(ruta, correccion) {
    const ids = String(process.env.TELEGRAM_ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!ids.length || !tg.hayToken()) return;
    const e = tg.escaparHTML;
    const t = ruta.totales;
    const cambio = ruta.cambioInicial || 0;
    const lineas = correccion
        ? [
            `✏️ <b>${e(ruta.repartidorNombre)}</b> corrigió su cuenta del ${e(ruta.fechaReparto)}`,
            ...correccion.cambios.map((c) => `• ${e(c)}`),
            `Efectivo a entregar: ${pesos(correccion.aEntregarAntes)} → <b>${pesos(correccion.aEntregarDespues)}</b>`,
            '',
            '<b>Cuenta nueva:</b>',
        ]
        : [
            `🚚 <b>${e(ruta.repartidorNombre)}</b> cerró su ruta del ${e(ruta.fechaReparto)} · ${ruta.pedidos.length} pedidos`,
            '',
        ];
    lineas.push(
        `💵 Efectivo ${pesos(t.efectivo)} · 💳 Tarjeta ${pesos(t.tarjeta)} · 🏦 Transferencia ${pesos(t.transferencia)}`,
    );
    if (ruta.gastos.length) {
        lineas.push(`⛽ Gastos -${pesos(t.gastos)} (${ruta.gastos.map((g) => `${e(g.concepto)} ${pesos(g.monto)}`).join(', ')})`);
    }
    lineas.push(`💰 <b>Efectivo a entregar: ${pesos(t.efectivo + cambio - t.gastos)}</b> (con cambio ${pesos(cambio)})`);
    if (t.cancelados.length) lineas.push(`❌ Canceló: ${t.cancelados.map(e).join(', ')}`);
    for (const chatId of ids) {
        const r = await tg.enviarMensaje({ chatId, texto: lineas.join('\n') });
        if (!r.ok) console.log(`Telegram cierre de ruta a ${chatId}: ${r.desc || r.tipo}`);
    }
}

// Crear ruta (admin)
router.post('/', requireAdmin, async (req, res) => {
    try {
        const ruta = await Ruta.create(req.body);
        res.status(201).json(ruta);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Crear todas las rutas del día de un jalón (admin), desde la nota completa.
// Si un repartidor ya tiene ruta ese día: se reemplaza solo si sigue sin tocar
// y el admin lo confirma (reemplazar: true).
router.post('/lote', requireAdmin, async (req, res) => {
    try {
        const { fechaReparto, cambioInicial, rutas, reemplazar } = req.body || {};
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fechaReparto || ''))) return res.status(400).json({ error: 'Fecha inválida' });
        if (!Array.isArray(rutas) || !rutas.length) return res.status(400).json({ error: 'No hay rutas' });
        const ids = rutas.map((r) => String(r.repartidorId || ''));
        if (ids.some((id) => !/^[a-f0-9]{24}$/i.test(id))) return res.status(400).json({ error: 'Falta elegir el repartidor de alguna ruta' });
        if (new Set(ids).size !== ids.length) return res.status(400).json({ error: 'Un repartidor aparece en dos rutas' });
        if (rutas.some((r) => !Array.isArray(r.pedidos) || !r.pedidos.length)) return res.status(400).json({ error: 'Hay una ruta sin entregas' });

        const reps = await Repartidor.find({ _id: { $in: ids } });
        if (reps.length !== ids.length) return res.status(400).json({ error: 'Repartidor no encontrado' });
        const nombreDe = (id) => reps.find((r) => String(r._id) === String(id)).nombre;

        const existentes = await Ruta.find({ fechaReparto, repartidorId: { $in: ids } });
        const tocadas = existentes.filter((r) => r.estado !== 'pendiente' || r.pedidos.some((p) => p.pago));
        if (tocadas.length) {
            return res.status(409).json({
                error: `${tocadas.map((r) => r.repartidorNombre).join(', ')} ya empezó su cuenta de ese día. Modifica esa ruta desde Resultados.`,
            });
        }
        if (existentes.length && !reemplazar) {
            return res.status(409).json({ existentes: existentes.map((r) => r.repartidorNombre) });
        }

        const docs = rutas.map((r) => {
            const pedidos = r.pedidos.map((p) => {
                const limpio = {};
                for (const k of CAMPOS_ENTREGA) if (p[k] !== undefined && p[k] !== null) limpio[k] = p[k];
                limpio.total = Number(p.total) || 0;
                return limpio;
            });
            return {
                fechaReparto,
                diaSemana: (pedidos.find((p) => p.diaDetectado) || {}).diaDetectado || null,
                repartidorId: r.repartidorId,
                repartidorNombre: nombreDe(r.repartidorId),
                cambioInicial: Number(r.cambioInicial ?? cambioInicial) || 0,
                pedidos,
            };
        });

        if (existentes.length) await Ruta.deleteMany({ _id: { $in: existentes.map((r) => r._id) } });
        const creadas = await Ruta.insertMany(docs);
        console.log(`📋 ${creadas.length} rutas del ${fechaReparto} subidas por ${req.admin && req.admin.usuario}${existentes.length ? ` (reemplazó ${existentes.length})` : ''}`);
        res.status(201).json(creadas);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Listar rutas por fecha (admin)
router.get('/', requireAdmin, async (req, res) => {
    try {
        const { fecha, repartidorId } = req.query;
        const filter = {};
        if (fecha) filter.fechaReparto = fecha;
        if (repartidorId) filter.repartidorId = repartidorId;
        const rutas = await Ruta.find(filter).sort({ createdAt: -1 });
        res.json(rutas);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Obtener ruta del día por teléfono del repartidor (público con filtro)
// Con token de repartidor, solo su propia ruta. Admin (o sin token mientras
// REPARTIDORES_ABIERTO) puede todas.
const esSuya = (req, ruta) => !req.repartidor || String(ruta.repartidorId) === String(req.repartidor.sub);

// Modificar ruta (admin): entregas (quitar, editar, añadir, reordenar), cambio y repartidor
router.put('/:id', requireAdmin, async (req, res) => {
    try {
        const ruta = await Ruta.findById(req.params.id);
        if (!ruta) return res.status(404).json({ error: 'Ruta no encontrada' });
        const { pedidos, cambioInicial, repartidorId, fechaReparto } = req.body || {};

        if (repartidorId && String(repartidorId) !== String(ruta.repartidorId)) {
            const rep = /^[a-f0-9]{24}$/i.test(String(repartidorId)) ? await Repartidor.findById(repartidorId) : null;
            if (!rep) return res.status(400).json({ error: 'Repartidor no encontrado' });
            ruta.repartidorId = rep._id;
            ruta.repartidorNombre = rep.nombre;
        }
        if (cambioInicial !== undefined) ruta.cambioInicial = Number(cambioInicial) || 0;
        if (fechaReparto && /^\d{4}-\d{2}-\d{2}$/.test(fechaReparto)) ruta.fechaReparto = fechaReparto;

        if (Array.isArray(pedidos)) {
            if (!pedidos.length) return res.status(400).json({ error: 'La ruta debe tener al menos una entrega. Si ya no va, bórrala.' });
            ruta.pedidos = pedidos.map((p) => {
                const previo = p && p._id ? ruta.pedidos.id(p._id) : null;
                const base = previo ? previo.toObject() : {};
                for (const k of CAMPOS_ENTREGA) if (p[k] !== undefined) base[k] = p[k];
                base.total = Number(p.total) || 0;
                return base;
            });
        }

        if (ruta.estado === 'cerrada') ruta.totales = calcularTotales(ruta.pedidos, ruta.gastos);
        await ruta.save();
        console.log(`✏️ Ruta de ${ruta.repartidorNombre} del ${ruta.fechaReparto} modificada por ${req.admin && req.admin.usuario} (${ruta.pedidos.length} entregas)`);
        res.json(ruta);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Borrar ruta (admin) — para rutas de prueba o asignadas por error
router.delete('/:id', requireAdmin, async (req, res) => {
    try {
        const ruta = await Ruta.findByIdAndDelete(req.params.id);
        if (!ruta) return res.status(404).json({ error: 'Ruta no encontrada' });
        console.log(`🗑️ Ruta de ${ruta.repartidorNombre} del ${ruta.fechaReparto} (${ruta.pedidos.length} pedidos, ${ruta.estado}) borrada por ${req.admin && req.admin.usuario}`);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/hoy', async (req, res) => {
    try {
        const { fecha } = req.query;
        // Un repartidor con sesión solo ve SU ruta: el teléfono sale del token.
        const telefono = req.repartidor ? req.repartidor.telefono : req.query.telefono;
        if (!telefono) return res.status(400).json({ error: 'Falta telefono' });
        const rep = await Repartidor.findOne({ telefono });
        if (!rep) return res.status(404).json({ error: 'Repartidor no encontrado' });
        const fechaBuscar = fecha || hoyStr();
        let ruta = await Ruta.findOne({
            repartidorId: rep._id,
            fechaReparto: fechaBuscar,
        });
        if (!ruta) {
            ruta = await Ruta.findOne({
                repartidorId: rep._id,
                estado: { $ne: 'cerrada' },
            }).sort({ fechaReparto: -1 });
        }
        if (!ruta) return res.status(404).json({ error: 'Sin ruta' });
        res.json({ ...ruta.toObject(), puedeCorregir: puedeCorregir(ruta) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Actualizar pago de un pedido (público — el repartidor lo llama desde su sesión)
router.patch('/:id/pedido/:pedidoId', async (req, res) => {
    try {
        const ruta = await Ruta.findById(req.params.id);
        if (!ruta) return res.status(404).json({ error: 'Ruta no encontrada' });
        if (!esSuya(req, ruta)) return res.status(403).json({ error: 'Esta ruta no es tuya' });
        // Ruta ya cerrada: la corrección se manda completa al volver a confirmar.
        if (ruta.estado === 'cerrada') return res.status(409).json({ error: 'La ruta ya está cerrada' });
        const pedido = ruta.pedidos.id(req.params.pedidoId);
        if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

        const { pago, descuento, notaRepartidor, pagoDetalle } = req.body;
        if (pago !== undefined) pedido.pago = pago;
        if (descuento !== undefined) pedido.descuento = descuento;
        if (notaRepartidor !== undefined) pedido.notaRepartidor = notaRepartidor;
        if (pagoDetalle !== undefined) pedido.pagoDetalle = pagoDetalle;

        if (ruta.estado === 'pendiente') ruta.estado = 'en_curso';
        await ruta.save();
        res.json(pedido);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cerrar ruta — calcula totales y opcionalmente notifica al admin
router.post('/:id/cerrar', async (req, res) => {
    try {
        const ruta = await Ruta.findById(req.params.id);
        if (!ruta) return res.status(404).json({ error: 'Ruta no encontrada' });
        if (!esSuya(req, ruta)) return res.status(403).json({ error: 'Esta ruta no es tuya' });

        // Volver a confirmar una ruta cerrada = corrección: el repartidor solo el mismo día.
        const esCorreccion = ruta.estado === 'cerrada';
        if (esCorreccion && req.repartidor && !puedeCorregir(ruta)) {
            return res.status(403).json({ error: 'Ya no puedes corregir esta cuenta (solo el mismo día). Pídele a un admin que la corrija.' });
        }
        const antes = esCorreccion ? fotoCuenta(ruta) : null;

        const { pagos, gastos } = req.body || {};
        if (pagos && typeof pagos === 'object') {
            for (const pedido of ruta.pedidos) {
                const reg = pagos[pedido._id?.toString()];
                if (!reg) continue;
                if (reg.pago !== undefined) pedido.pago = reg.pago;
                if (reg.descuento !== undefined) pedido.descuento = reg.descuento;
                if (reg.notaRepartidor !== undefined) pedido.notaRepartidor = reg.notaRepartidor;
                if (reg.pagoDetalle !== undefined) pedido.pagoDetalle = reg.pagoDetalle;
            }
        }

        if (gastos !== undefined) ruta.gastos = limpiarGastos(gastos);
        ruta.totales = calcularTotales(ruta.pedidos, ruta.gastos);
        ruta.estado = 'cerrada';
        ruta.cerradaAt = new Date();

        let correccion = null;
        if (esCorreccion) {
            const despues = fotoCuenta(ruta);
            const cambio = ruta.cambioInicial || 0;
            correccion = {
                cambios: cambiosCuenta(antes, despues),
                aEntregarAntes: antes.totales.efectivo + cambio - (antes.totales.gastos || 0),
                aEntregarDespues: despues.totales.efectivo + cambio - (despues.totales.gastos || 0),
            };
            // Sin cambios reales: no se registra ni se avisa.
            if (!correccion.cambios.length) {
                await ruta.save();
                return res.json(ruta);
            }
            if (!ruta.cierreOriginal) ruta.cierreOriginal = antes;
            ruta.correcciones.push({
                at: new Date(),
                por: req.repartidor ? 'repartidor' : (req.admin && req.admin.usuario) || 'admin',
                cambios: correccion.cambios,
                totalesAntes: antes.totales,
                totalesDespues: despues.totales,
            });
        }
        await ruta.save();

        // Email opcional al admin (no bloqueante)
        if (process.env.ADMIN_EMAIL) {
            try {
                const nodemailer = require('nodemailer');
                const transporter = nodemailer.createTransport({
                    host: process.env.EMAIL_HOST,
                    port: process.env.EMAIL_PORT,
                    secure: true,
                    auth: {
                        user: process.env.EMAIL_USER,
                        pass: process.env.EMAIL_PASS,
                    },
                });
                const t = ruta.totales;
                const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
                const gastosHtml = ruta.gastos.length
                    ? `<li>⛽ Gastos: -$${t.gastos} (${ruta.gastos.map((g) => `${esc(g.concepto)} $${g.monto}`).join(', ')})</li>`
                    : '';
                const aEntregar = t.efectivo + (ruta.cambioInicial || 0) - t.gastos;
                transporter
                    .sendMail({
                        from: process.env.EMAIL_USER,
                        to: process.env.ADMIN_EMAIL,
                        subject: correccion
                            ? `✏️ ${ruta.repartidorNombre} corrigió su cuenta del ${ruta.fechaReparto}`
                            : `🚚 ${ruta.repartidorNombre} cerró su ruta del ${ruta.fechaReparto}`,
                        html: `
                            ${correccion ? `<h2>${esc(ruta.repartidorNombre)} corrigió su cuenta</h2>
                            <ul>${correccion.cambios.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
                            <p>Efectivo a entregar: $${correccion.aEntregarAntes} → <strong>$${correccion.aEntregarDespues}</strong></p>
                            <h3>Cuenta nueva</h3>` : `<h2>${esc(ruta.repartidorNombre)} terminó su ruta</h2>`}
                            <p><strong>Fecha:</strong> ${ruta.fechaReparto} (${ruta.diaSemana || ''})</p>
                            <p><strong>Pedidos:</strong> ${ruta.pedidos.length}</p>
                            <ul>
                              <li>💵 Efectivo: $${t.efectivo}</li>
                              <li>💳 Tarjeta: $${t.tarjeta}</li>
                              <li>🏦 Transferencia: $${t.transferencia}</li>
                              ${gastosHtml}
                              <li><strong>Efectivo a entregar (con cambio $${ruta.cambioInicial || 0}): $${aEntregar}</strong></li>
                              <li>❌ Cancelados: ${t.cancelados.join(', ') || '-'}</li>
                            </ul>
                            <p>Entra al panel para ver el detalle.</p>
                        `,
                    })
                    .catch((e) => console.log('Email cerrar ruta error:', e.message));
            } catch (e) {
                console.log('Email setup error:', e.message);
            }
        }

        // Aviso por Telegram (no bloqueante)
        avisarCierreTelegram(ruta, correccion).catch((e) => console.log('Telegram cerrar ruta error:', e.message));

        res.json(ruta);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
