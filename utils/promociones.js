const Promocion = require('../models/Promocion');

// Canal del pedido a partir de `via` ('web' => web, cualquier otra cosa => manual)
const canalDe = (via) => (via === 'web' ? 'web' : 'manual');

// Promos activas que APLICARÍAN a este pedido (sin reclamar cupo).
// Sirve para el endpoint /activas (mostrar al usuario) y como base del claim.
async function promosAplicables({ via, fecha }) {
    const canal = canalDe(via);
    return Promocion.find({
        activa: true,
        canal: { $in: [canal, 'ambos'] },
        $or: [{ fechaEntrega: '' }, { fechaEntrega: fecha || '' }],
    });
}

// Intenta RECLAMAR (atómico) cada promo aplicable. Devuelve las efectivamente aplicadas.
// - contarPor='cliente': dedup por teléfono (un beneficio por cliente).
// - contarPor='pedido': solo respeta el límite global.
// - limite=0: sin tope.
async function reclamarPromociones({ via, fecha, telefono }) {
    const candidatas = await promosAplicables({ via, fecha });
    const aplicadas = [];

    for (const p of candidatas) {
        const filtro = { _id: p._id, activa: true };
        if (p.limite && p.limite > 0) filtro.usados = { $lt: p.limite };
        if (p.contarPor === 'cliente' && telefono) filtro.telefonosReclamados = { $ne: telefono };

        const upd = { $inc: { usados: 1 } };
        if (p.contarPor === 'cliente' && telefono) upd.$push = { telefonosReclamados: telefono };

        const claim = await Promocion.findOneAndUpdate(filtro, upd, { new: true });
        if (claim) aplicadas.push(claim); // null => agotado o ya reclamado por este cliente
    }

    return aplicadas;
}

module.exports = { canalDe, promosAplicables, reclamarPromociones };
