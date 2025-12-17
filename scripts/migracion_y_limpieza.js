const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const Clientes = require('../models/Clientes'); 

if (!process.env.MONGO_URL) {
    console.error("🔴 Error: No se encontró MONGO_URL.");
    process.exit(1);
}

mongoose.connect(process.env.MONGO_URL)
    .then(() => {
        console.log("🟢 Conectado. Iniciando Migración: Alias + Doble Número + Blindaje...");
        iniciarLimpieza();
    })
    .catch(err => { console.error(err); process.exit(1); });

// --- UTILIDADES ---

const normalizarTelefono = (input) => {
    if (!input) return "";
    let limpio = input.toString().replace(/\D/g, ''); 
    // Ajustes de Lada
    if (limpio.startsWith('52') && limpio.length > 10) limpio = limpio.substring(2);
    if (limpio.startsWith('1') && limpio.length === 11) limpio = limpio.substring(1);
    return limpio;
};

const extraerAlias = (nombre, fallback = 'Dirección Principal') => {
    if (!nombre) return fallback;
    if (nombre.includes('-')) {
        const partes = nombre.split('-');
        const posibleAlias = partes[1].trim();
        if (posibleAlias.length > 0) return posibleAlias;
    }
    return fallback;
};

// --- SCRIPT PRINCIPAL ---

const iniciarLimpieza = async () => {
    try {
        const todosLosClientes = await Clientes.find({});
        console.log(`📊 Analizando ${todosLosClientes.length} clientes...`);

        const grupos = {};
        const aEliminar = [];
        const aGuardar = [];

        // 1. PRE-PROCESAMIENTO Y AGRUPADO
        todosLosClientes.forEach(cliente => {
            // A. DETECTOR DE DOBLE NÚMERO
            // Obtenemos los dígitos crudos
            let rawDigits = cliente.telefono ? cliente.telefono.toString().replace(/\D/g, '') : '';
            
            // Si tiene más de 16 dígitos, asumimos que son 2 números pegados (ej: 771... y 771...)
            if (rawDigits.length > 16) {
                console.log(`⚠️ Doble número detectado en ${cliente.nombre}: ${cliente.telefono}`);
                
                // Cortamos los primeros 10 para el principal
                const num1 = rawDigits.substring(0, 10);
                // El resto lo mandamos a secundario
                const num2 = rawDigits.substring(10, 20); // Tomamos los siguientes 10
                
                // Actualizamos el objeto en memoria
                cliente.telefono = num1;
                
                // Si no tiene secundario, guardamos el segundo ahí
                if (!cliente.telefonoSecundario) {
                    cliente.telefonoSecundario = num2;
                }
            }

            // B. NORMALIZACIÓN ESTÁNDAR
            const numeroLimpio = normalizarTelefono(cliente.telefono);
            
            if (numeroLimpio.length < 10) return; // Ignoramos basura

            if (!grupos[numeroLimpio]) grupos[numeroLimpio] = [];
            grupos[numeroLimpio].push(cliente);
        });

        // 2. PROCESAR GRUPOS
        for (const numero in grupos) {
            const cuentas = grupos[numero];

            // CASO A: ÚNICO
            if (cuentas.length === 1) {
                const cliente = cuentas[0];
                const numLimpio = normalizarTelefono(cliente.telefono);
                let huboCambios = false;
                
                // Corrección número
                if (cliente.telefono !== numLimpio) {
                    cliente.telefono = numLimpio;
                    huboCambios = true;
                }
                
                // Corrección MisDirecciones
                if (!cliente.misDirecciones || cliente.misDirecciones.length === 0) {
                    cliente.misDirecciones = [{
                        alias: extraerAlias(cliente.nombre, 'Dirección Principal'),
                        direccion: cliente.direccion,
                        gpsLink: cliente.gpsLink
                    }];
                    huboCambios = true;
                }

                // Guardar si hubo cambios (incluyendo el telefonoSecundario nuevo si aplicó)
                // Ojo: Mongoose detecta los cambios en memoria
                if (huboCambios || cliente.isModified('telefonoSecundario')) {
                     aGuardar.push(cliente);
                }
                continue;
            }

            // CASO B: FUSIÓN DE DUPLICADOS
            console.log(`⚡ FUSIONANDO ${cuentas.length} cuentas -> Cel: ${numero}`);
            
            cuentas.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            const maestro = cuentas[0];
            
            maestro.telefono = numero;
            if (!maestro.misDirecciones) maestro.misDirecciones = [];

            // Guardar dirección del maestro
            const maestroDirExiste = maestro.misDirecciones.some(d => d.direccion === maestro.direccion);
            if (!maestroDirExiste && maestro.direccion) {
                maestro.misDirecciones.push({
                    alias: extraerAlias(maestro.nombre, 'Dirección Principal'),
                    direccion: maestro.direccion,
                    gpsLink: maestro.gpsLink
                });
            }

            // Procesar Hijos
            for (let i = 1; i < cuentas.length; i++) {
                const hijo = cuentas[i];

                // --- MATEMÁTICAS BLINDADAS (NaN FIX) ---
                maestro.puntos = (maestro.puntos || 0) + (hijo.puntos || 0);
                maestro.sellos = (maestro.sellos || 0) + (hijo.sellos || 0);
                maestro.ruletaTokens = (maestro.ruletaTokens || 0) + (hijo.ruletaTokens || 0);
                maestro.totalGastado = (maestro.totalGastado || 0) + (hijo.totalGastado || 0);
                maestro.totalPedidos = (maestro.totalPedidos || 0) + (hijo.totalPedidos || 0);

                // Arrays
                if (hijo.pedidos?.length > 0) maestro.pedidos = [...(maestro.pedidos||[]), ...hijo.pedidos];
                if (hijo.premiosPendientes?.length > 0) maestro.premiosPendientes = [...(maestro.premiosPendientes||[]), ...hijo.premiosPendientes];

                // Direcciones
                const yaExiste = maestro.misDirecciones.some(d => d.direccion === hijo.direccion);
                if (!yaExiste && hijo.direccion) {
                    maestro.misDirecciones.push({
                        alias: extraerAlias(hijo.nombre, `Dirección ${i}`),
                        direccion: hijo.direccion,
                        gpsLink: hijo.gpsLink
                    });
                }
                
                if (hijo.misDirecciones?.length > 0) {
                    hijo.misDirecciones.forEach(dirHijo => {
                         const existeEnMaestro = maestro.misDirecciones.some(d => d.direccion === dirHijo.direccion);
                         if (!existeEnMaestro) maestro.misDirecciones.push(dirHijo);
                    });
                }
                
                // Si el hijo tenía telefonoSecundario y el maestro no, lo robamos
                if (!maestro.telefonoSecundario && hijo.telefonoSecundario) {
                    maestro.telefonoSecundario = hijo.telefonoSecundario;
                }

                aEliminar.push(hijo._id);
            }
            aGuardar.push(maestro);
        }

        // 3. GUARDAR
        console.log(`📝 Actualizando: ${aGuardar.length} | Eliminando: ${aEliminar.length}`);

        if (aGuardar.length > 0) {
            console.log("💾 Guardando cambios...");
            await Promise.all(aGuardar.map(c => c.save()));
        }

        if (aEliminar.length > 0) {
            console.log("🗑️  Borrando duplicados...");
            await Clientes.deleteMany({ _id: { $in: aEliminar } });
        }

        console.log("✅ ¡MIGRACIÓN COMPLETADA CON ÉXITO!");
        process.exit();

    } catch (error) {
        console.error("❌ Error inesperado:", error);
        process.exit(1);
    }
};