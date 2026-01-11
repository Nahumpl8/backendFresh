const router = require('express').Router();
const User = require('../models/User');
const CryptoJS = require('crypto-js');
const jwt = require('jsonwebtoken');

// 👇 1. IMPORTAMOS EL SERVICIO DE EMAIL (Asegúrate de que la ruta sea correcta)
const { sendWelcomeEmail } = require('../utils/emailService');

//REGISTER
router.post('/register', async (req, res) => {
    const newUser = new User({
        username: req.body.username,
        email: req.body.email,
        password: CryptoJS.AES.encrypt(
            req.body.password,
            process.env.PASS_SEC
        ).toString(),
    });

    try {
        const savedUser = await newUser.save();

        // 👇 2. AGREGAMOS EL ENVÍO DE CORREO AQUÍ
        // Usamos 'savedUser.username' como nombre para el correo.
        if (savedUser.email) {
            // No usamos 'await' para que el usuario no tenga que esperar a que se envíe el correo
            sendWelcomeEmail(savedUser.email, savedUser.username, savedUser._id);
        }

        console.log(savedUser);
        res.status(201).json(savedUser);
    } catch (err) {
        // Es bueno ver el error en consola si falla algo
        console.error(err);
        res.status(500).json(err);
    }
});

//LOGIN
router.post('/login', async (req, res) => {
    try {
        const user = await User.findOne({ username: req.body.username });
        !user && res.status(401).json('Wrong username!');

        // Corrección de seguridad: Si no hay usuario, detener aquí para evitar error en decrypt
        if (!user) return res.status(401).json('Wrong username!');

        const hashPassword = CryptoJS.AES.decrypt(
            user.password,
            process.env.PASS_SEC
        );
        const originalPassword = hashPassword.toString(CryptoJS.enc.Utf8);
        originalPassword !== req.body.password && res.status(401).json('Wrong password!');

        // Corrección de seguridad: Si password está mal, detener
        if (originalPassword !== req.body.password) return res.status(401).json('Wrong password!');

        const accessToken = jwt.sign(
            {
                id: user._id,
                isAdmin: user.isAdmin,
            },
            process.env.JWT_SEC,
            { expiresIn: '3d' }
        );

        const { password, ...others } = user._doc;

        res.status(200).json({ ...others, accessToken });

    } catch (err) {
        res.status(500).json(err);
    }
})

module.exports = router;