const router = require('express').Router();
const jwt = require('jsonwebtoken');

router.post('/login', (req, res) => {
    const { password } = req.body || {};
    if (!password || password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    const token = jwt.sign({ role: 'fresh-admin' }, process.env.JWT_SEC, {
        expiresIn: '30d',
    });
    res.json({ token });
});

module.exports = router;
