const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const Clientes = require('../models/Clientes');

// VERIFICACIÓN DE ENTORNO
if (!process.env.MONGO_URL) {
    console.error("🔴 Error: No se encontró MONGO_URL.");
    process.exit(1);
}

// CONEXIÓN
mongoose.connect(process.env.MONGO_URL)
    .then(() => {
        console.log("🟢 Conectado. Iniciando Sincronización de Direcciones...");
        sincronizar();
    })
    .catch(err => { console.error(err); process.exit(1); });

// --- UTILERÍA: EXTRAER ALIAS ---
const extraerAlias = (nombre, fallback = 'Dirección Principal') => {
    if (!nombre) return fallback;
    if (nombre.includes('-')) {
        const partes = nombre.split('-');
        const posibleAlias = partes[1].trim();
        if (posibleAlias.length > 0) return posibleAlias;
    }
    return fallback;
};

const sincronizar = async () => {
    try {
        const clientes = await Clientes.find({});
        console.log(`📊 Revisando ${clientes.length} clientes...`);

        let actualizados = 0;

        for (const cliente of clientes) {
            let huboCambios = false;

            // 1. Asegurar que el array exista
            if (!cliente.misDirecciones) {
                cliente.misDirecciones = [];
            }

            // 2. Revisar si la dirección PRINCIPAL actual ya está en la lista
            // (Comparamos strings limpios para evitar duplicados por espacios extra)
            const dirPrincipal = cliente.direccion ? cliente.direccion.trim() : '';

            if (dirPrincipal.length > 2) { // Solo si tiene una dirección válida

                const yaExisteEnLista = cliente.misDirecciones.some(d =>
                    d.direccion && d.direccion.trim() === dirPrincipal
                );

                // 3. SI NO ESTÁ, LA AGREGAMOS
                if (!yaExisteEnLista) {
                    // Usamos la lógica de alias para ponerle nombre bonito
                    const aliasCalculado = extraerAlias(cliente.nombre, 'Dirección Actual');

                    cliente.misDirecciones.push({
                        alias: aliasCalculado,
                        direccion: cliente.direccion,
                        gpsLink: cliente.gpsLink || ''
                    });

                    huboCambios = true;
                    // console.log(`➕ Agregada dirección faltante a: ${cliente.nombre}`);
                }
            }

            // 4. GUARDAR SOLO SI HUBO CAMBIOS
            if (huboCambios) {
                await cliente.save();
                actualizados++;
            }
        }

        console.log(`\n✅ PROCESO TERMINADO`);
        console.log(`📝 Se corrigieron/actualizaron: ${actualizados} clientes.`);
        console.log(`👍 El resto ya tenía sus direcciones sincronizadas.`);

        process.exit();

    } catch (error) {
        console.error("❌ Error:", error);
        process.exit(1);
    }
};