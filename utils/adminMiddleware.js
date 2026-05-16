const jwt = require('jsonwebtoken');

const requireAdmin = (req, res, next) => {
    const header = req.headers.authorization || req.headers.Authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = header.slice(7);
    jwt.verify(token, process.env.JWT_SEC, (err, payload) => {
        if (err) return res.status(403).json({ error: 'Token inválido o expirado' });
        if (!payload || payload.role !== 'fresh-admin') {
            return res.status(403).json({ error: 'No autorizado' });
        }
        req.admin = payload;
        next();
    });
};

module.exports = { requireAdmin };
