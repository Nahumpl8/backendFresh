const router = require('express').Router();
const Ruta = require('../models/Ruta');
const Repartidor = require('../models/Repartidor');
const { requireAdmin } = require('../utils/adminMiddleware');

const hoyStr = () => {
    // YYYY-MM-DD en zona local del servidor
    const d = new Date();
    const tzOffset = d.getTimezoneOffset() * 60000;
    return new Date(d - tzOffset).toISOString().slice(0, 10);
};

const calcularTotales = (pedidos) => {
    const t = { efectivo: 0, tarjeta: 0, transferencia: 0, cancelados: [] };
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

// Crear ruta (admin)
router.post('/', requireAdmin, async (req, res) => {
    try {
        const ruta = await Ruta.create(req.body);
        res.status(201).json(ruta);
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
router.get('/hoy', async (req, res) => {
    try {
        const { telefono, fecha } = req.query;
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
        res.json(ruta);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Actualizar pago de un pedido (público — el repartidor lo llama desde su sesión)
router.patch('/:id/pedido/:pedidoId', async (req, res) => {
    try {
        const ruta = await Ruta.findById(req.params.id);
        if (!ruta) return res.status(404).json({ error: 'Ruta no encontrada' });
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

        const { pagos } = req.body || {};
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

        ruta.totales = calcularTotales(ruta.pedidos);
        ruta.estado = 'cerrada';
        ruta.cerradaAt = new Date();
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
                transporter
                    .sendMail({
                        from: process.env.EMAIL_USER,
                        to: process.env.ADMIN_EMAIL,
                        subject: `🚚 ${ruta.repartidorNombre} cerró su ruta del ${ruta.fechaReparto}`,
                        html: `
                            <h2>${ruta.repartidorNombre} terminó su ruta</h2>
                            <p><strong>Fecha:</strong> ${ruta.fechaReparto} (${ruta.diaSemana || ''})</p>
                            <p><strong>Pedidos:</strong> ${ruta.pedidos.length}</p>
                            <ul>
                              <li>💵 Efectivo: $${t.efectivo}</li>
                              <li>💳 Tarjeta: $${t.tarjeta}</li>
                              <li>🏦 Transferencia: $${t.transferencia}</li>
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

        res.json(ruta);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
