const router = require('express').Router();
const Clientes = require('../models/Clientes');
const CryptoJS = require('crypto-js');
const jwt = require('jsonwebtoken');

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
        
        // Actualizar cliente
        cliente.pin = hashedPin;
        if (email) {
            cliente.email = email.toLowerCase().trim();
        }
        await cliente.save();
        
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
        
        if (!cliente || !cliente.email) {
            // Por seguridad, no revelamos si el cliente existe
            return res.status(200).json({ 
                success: true,
                message: 'Si el email existe en nuestro sistema, recibirás instrucciones para recuperar tu PIN'
            });
        }

        // TODO: Implementar envío de email con código de recuperación
        // Por ahora solo confirmamos
        // Aquí podrías:
        // 1. Generar un código de recuperación temporal
        // 2. Guardarlo en la BD con expiración
        // 3. Enviar email con el código
        // 4. Crear endpoint /reset-pin que acepte el código
        
        res.status(200).json({ 
            success: true,
            message: 'Si el email está registrado, recibirás instrucciones para recuperar tu PIN'
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

