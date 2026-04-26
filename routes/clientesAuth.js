const router = require('express').Router();
const crypto = require('crypto');
const Clientes = require('../models/Clientes');
const CryptoJS = require('crypto-js');
const jwt = require('jsonwebtoken');

const { sendWelcomeEmail, sendPinRecoveryEmail } = require('../utils/emailService');

// Hash SHA-256 (para guardar el código de recuperación, no en plano)
function hashCodigo(codigo) {
    return crypto.createHash('sha256').update(String(codigo)).digest('hex');
}

// Utilidad para limpiar teléfono
function limpiarTelefono(tel) {
    return tel.replace(/\D/g, '').replace(/^52/, '').trim();
}

// Validar formato de email
function esEmail(valor) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valor);
}

// ==========================================
// SETUP PIN (Registro/Configuración inicial)
// ==========================================
router.post('/setup-pin', async (req, res) => {
    try {
        const { telefono, pin, email } = req.body;

        // Validaciones
        if (!telefono || !pin) {
            return res.status(400).json({
                success: false,
                error: 'Teléfono y PIN son requeridos'
            });
        }

        if (pin.length < 4 || pin.length > 8) {
            return res.status(400).json({
                success: false,
                error: 'El PIN debe tener entre 4 y 8 dígitos'
            });
        }

        // Validar email si se proporciona
        if (email && !esEmail(email)) {
            return res.status(400).json({
                success: false,
                error: 'Formato de email inválido'
            });
        }

        const telefonoLimpio = limpiarTelefono(telefono);

        // Buscar cliente existente
        const cliente = await Clientes.findOne({
            telefono: { $regex: telefonoLimpio + '$' }
        });

        if (!cliente) {
            return res.status(404).json({
                success: false,
                error: 'Cliente no encontrado. Contacta a Fresh Market para registrarte primero.'
            });
        }

        // Si ya tiene PIN configurado
        if (cliente.pin) {
            return res.status(400).json({
                success: false,
                error: 'Ya tienes un PIN configurado. Usa "¿Olvidaste tu PIN?" si no lo recuerdas.'
            });
        }

        // Verificar que el email no esté en uso por otro cliente
        if (email) {
            const emailExistente = await Clientes.findOne({
                email: email.toLowerCase().trim(),
                _id: { $ne: cliente._id } // Excluir el cliente actual
            });

            if (emailExistente) {
                return res.status(400).json({
                    success: false,
                    error: 'Este email ya está registrado con otra cuenta'
                });
            }
        }

        // Encriptar PIN
        const secretKey = process.env.PASS_SEC || process.env.JWT_SEC;
        const hashedPin = CryptoJS.AES.encrypt(pin, secretKey).toString();

        // Guardar email anterior para verificar si es primera vez
        const emailAnterior = cliente.email;

        // Actualizar cliente
        cliente.pin = hashedPin;
        if (email) {
            cliente.email = email.toLowerCase().trim();
        }
        await cliente.save();

        if (email && !emailAnterior && cliente.email) {
            sendWelcomeEmail(cliente.email, cliente.nombre, cliente._id.toString())
                .catch(err => console.error('Error enviando correo de bienvenida:', err));
        }

        // Generar token JWT
        const accessToken = jwt.sign(
            {
                id: cliente._id,
                telefono: cliente.telefono,
                email: cliente.email,
                tipo: 'cliente'
            },
            process.env.JWT_SEC,
            { expiresIn: '30d' }
        );

        const { pin: _, ...clienteData } = cliente._doc;

        res.status(200).json({
            success: true,
            message: 'PIN configurado exitosamente',
            accessToken,
            cliente: clienteData
        });

    } catch (err) {
        console.error('Error en setup-pin:', err);

        // Manejar error de email duplicado
        if (err.code === 11000) {
            return res.status(400).json({
                success: false,
                error: 'Este email ya está registrado'
            });
        }

        res.status(500).json({
            success: false,
            error: 'Error interno del servidor'
        });
    }
});

// ==========================================
// LOGIN con Teléfono O Email + PIN
// ==========================================
router.post('/login', async (req, res) => {
    try {
        const { telefono, email, pin } = req.body;

        // Validaciones: debe venir telefono O email (no ambos, no ninguno)
        if ((!telefono && !email) || (telefono && email)) {
            return res.status(400).json({
                success: false,
                error: 'Debes proporcionar teléfono o email (no ambos)'
            });
        }

        if (!pin) {
            return res.status(400).json({
                success: false,
                error: 'PIN es requerido'
            });
        }

        let cliente;

        // Buscar por teléfono o email
        if (telefono) {
            const telefonoLimpio = limpiarTelefono(telefono);
            cliente = await Clientes.findOne({
                telefono: { $regex: telefonoLimpio + '$' }
            });
        } else {
            // Buscar por email
            cliente = await Clientes.findOne({
                email: email.toLowerCase().trim()
            });
        }

        if (!cliente) {
            return res.status(404).json({
                success: false,
                error: 'Cliente no encontrado'
            });
        }

        if (!cliente.pin) {
            return res.status(400).json({
                success: false,
                error: 'No tienes PIN configurado. Configúralo primero.'
            });
        }

        // Desencriptar y verificar PIN
        const secretKey = process.env.PASS_SEC || process.env.JWT_SEC;
        const decryptedPin = CryptoJS.AES.decrypt(cliente.pin, secretKey);
        const originalPin = decryptedPin.toString(CryptoJS.enc.Utf8);

        if (originalPin !== pin) {
            return res.status(401).json({
                success: false,
                error: 'PIN incorrecto'
            });
        }

        // Generar token
        const accessToken = jwt.sign(
            {
                id: cliente._id,
                telefono: cliente.telefono,
                email: cliente.email,
                tipo: 'cliente'
            },
            process.env.JWT_SEC,
            { expiresIn: '30d' }
        );

        const { pin: _, ...clienteData } = cliente._doc;

        res.status(200).json({
            success: true,
            message: 'Login exitoso',
            accessToken,
            cliente: clienteData
        });

    } catch (err) {
        console.error('Error en login:', err);
        res.status(500).json({
            success: false,
            error: 'Error interno del servidor'
        });
    }
});

// ==========================================
// RECUPERAR PIN (por email)
// ==========================================
router.post('/forgot-pin', async (req, res) => {
    try {
        const { telefono, email } = req.body;

        // Puede venir por teléfono O email
        if (!telefono && !email) {
            return res.status(400).json({
                success: false,
                error: 'Debes proporcionar teléfono o email'
            });
        }

        let cliente;

        if (telefono) {
            const telefonoLimpio = limpiarTelefono(telefono);
            cliente = await Clientes.findOne({
                telefono: { $regex: telefonoLimpio + '$' }
            });
        } else {
            cliente = await Clientes.findOne({
                email: email.toLowerCase().trim()
            });
        }

        const mensajeGenerico = 'Si el email está registrado, recibirás instrucciones para recuperar tu PIN';

        if (!cliente || !cliente.email) {
            // Por seguridad, no revelamos si el cliente existe ni si tiene email
            return res.status(200).json({
                success: true,
                message: mensajeGenerico,
                hasEmail: false
            });
        }

        // 1. Generar código de 6 dígitos
        const codigo = crypto.randomInt(100000, 1000000).toString();

        // 2. Guardar hash + expiración (15 min)
        cliente.resetPinToken = hashCodigo(codigo);
        cliente.resetPinExpires = new Date(Date.now() + 15 * 60 * 1000);
        await cliente.save();

        // 3. Enviar email (no awaiteamos el resultado para no revelar fallas al cliente)
        sendPinRecoveryEmail(cliente.email, cliente.nombre, codigo)
            .catch(err => console.error('Error enviando correo de recuperación:', err));

        // 4. Email enmascarado para confirmar al usuario a dónde se envió
        const [user, domain] = cliente.email.split('@');
        const userMasked = user.length <= 2
            ? user[0] + '*'
            : user[0] + '*'.repeat(Math.max(1, user.length - 2)) + user[user.length - 1];
        const emailMasked = `${userMasked}@${domain}`;

        return res.status(200).json({
            success: true,
            message: mensajeGenerico,
            hasEmail: true,
            emailMasked
        });

    } catch (err) {
        console.error('Error en forgot-pin:', err);
        res.status(500).json({
            success: false,
            error: 'Error interno del servidor'
        });
    }
});

// ==========================================
// RESET PIN (con código recibido por email)
// ==========================================
router.post('/reset-pin', async (req, res) => {
    try {
        const { telefono, codigo, nuevoPin } = req.body;

        if (!telefono || !codigo || !nuevoPin) {
            return res.status(400).json({
                success: false,
                error: 'Teléfono, código y nuevo PIN son requeridos'
            });
        }

        if (!/^\d{4,8}$/.test(nuevoPin)) {
            return res.status(400).json({
                success: false,
                error: 'El PIN debe tener entre 4 y 8 dígitos numéricos'
            });
        }

        const telefonoLimpio = limpiarTelefono(telefono);
        const cliente = await Clientes.findOne({
            telefono: { $regex: telefonoLimpio + '$' }
        });

        const errorInvalido = {
            success: false,
            error: 'Código inválido o expirado. Solicita uno nuevo.'
        };

        if (!cliente || !cliente.resetPinToken || !cliente.resetPinExpires) {
            return res.status(400).json(errorInvalido);
        }

        if (cliente.resetPinExpires.getTime() < Date.now()) {
            return res.status(400).json(errorInvalido);
        }

        if (cliente.resetPinToken !== hashCodigo(codigo)) {
            return res.status(400).json(errorInvalido);
        }

        // Encriptar y guardar el nuevo PIN
        const secretKey = process.env.PASS_SEC || process.env.JWT_SEC;
        cliente.pin = CryptoJS.AES.encrypt(nuevoPin, secretKey).toString();
        cliente.resetPinToken = null;
        cliente.resetPinExpires = null;
        await cliente.save();

        // Auto-login: devolvemos accessToken (mismo shape que /login)
        const accessToken = jwt.sign(
            {
                id: cliente._id,
                telefono: cliente.telefono,
                email: cliente.email,
                tipo: 'cliente'
            },
            process.env.JWT_SEC,
            { expiresIn: '30d' }
        );

        const { pin: _, ...clienteData } = cliente._doc;

        res.status(200).json({
            success: true,
            message: 'PIN restablecido exitosamente',
            accessToken,
            cliente: clienteData
        });

    } catch (err) {
        console.error('Error en reset-pin:', err);
        res.status(500).json({
            success: false,
            error: 'Error interno del servidor'
        });
    }
});

// ==========================================
// ADMIN: Resetear PIN de un cliente
// (limpia el PIN — el cliente lo crea de nuevo en su próximo login)
// ==========================================
router.post('/admin-reset-pin', async (req, res) => {
    try {
        const { clienteId } = req.body;

        if (!clienteId) {
            return res.status(400).json({
                success: false,
                error: 'clienteId es requerido'
            });
        }

        const cliente = await Clientes.findById(clienteId);
        if (!cliente) {
            return res.status(404).json({
                success: false,
                error: 'Cliente no encontrado'
            });
        }

        cliente.pin = null;
        cliente.resetPinToken = null;
        cliente.resetPinExpires = null;
        await cliente.save();

        res.status(200).json({
            success: true,
            message: 'PIN reseteado. El cliente deberá crear uno nuevo al iniciar sesión.'
        });

    } catch (err) {
        console.error('Error en admin-reset-pin:', err);
        res.status(500).json({
            success: false,
            error: 'Error interno del servidor'
        });
    }
});

// ==========================================
// ACTUALIZAR EMAIL (para clientes ya registrados)
// ==========================================
router.put('/update-email', async (req, res) => {
    try {
        const { telefono, email, pin } = req.body;

        if (!telefono || !email || !pin) {
            return res.status(400).json({
                success: false,
                error: 'Teléfono, email y PIN son requeridos'
            });
        }

        if (!esEmail(email)) {
            return res.status(400).json({
                success: false,
                error: 'Formato de email inválido'
            });
        }

        const telefonoLimpio = limpiarTelefono(telefono);

        const cliente = await Clientes.findOne({
            telefono: { $regex: telefonoLimpio + '$' }
        });

        if (!cliente) {
            return res.status(404).json({
                success: false,
                error: 'Cliente no encontrado'
            });
        }

        if (!cliente.pin) {
            return res.status(400).json({
                success: false,
                error: 'No tienes PIN configurado'
            });
        }

        // Verificar PIN
        const secretKey = process.env.PASS_SEC || process.env.JWT_SEC;
        const decryptedPin = CryptoJS.AES.decrypt(cliente.pin, secretKey);
        const originalPin = decryptedPin.toString(CryptoJS.enc.Utf8);

        if (originalPin !== pin) {
            return res.status(401).json({
                success: false,
                error: 'PIN incorrecto'
            });
        }

        const emailAnterior = cliente.email;
        // Verificar que el email no esté en uso
        const emailExistente = await Clientes.findOne({
            email: email.toLowerCase().trim(),
            _id: { $ne: cliente._id }
        });

        if (emailExistente) {
            return res.status(400).json({
                success: false,
                error: 'Este email ya está registrado'
            });
        }

        // Actualizar email
        cliente.email = email.toLowerCase().trim();
        await cliente.save();

        // Enviar correo de bienvenida si es la primera vez que se agrega el email
        if (!emailAnterior && cliente.email) {
            sendWelcomeEmail(cliente.email, cliente.nombre, cliente._id.toString())
                .catch(err => console.error('Error enviando correo de bienvenida:', err));
        }

        res.status(200).json({
            success: true,
            message: 'Email actualizado exitosamente',
            cliente: {
                ...cliente._doc,
                pin: undefined
            }
        });

    } catch (err) {
        console.error('Error actualizando email:', err);

        if (err.code === 11000) {
            return res.status(400).json({
                success: false,
                error: 'Este email ya está registrado'
            });
        }

        res.status(500).json({
            success: false,
            error: 'Error interno del servidor'
        });
    }
});

module.exports = router;

