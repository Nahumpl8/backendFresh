/**
 * Recupera los clientes que pidieron sin cuenta y nunca quedaron registrados.
 *
 * Durante un tiempo, POST /pedidos/new solo BUSCABA al cliente: si el pedido
 * venía de alguien sin ficha (el checkout de freshmarket.mx deja pedir sin crear
 * cuenta), el pedido se guardaba pero la persona no aparecía en /clientes, no
 * acumulaba puntos ni sellos y no contaba para las estadísticas. Eso ya está
 * corregido en la ruta; este script repara el historial.
 *
 * Qué hace: agrupa los pedidos por teléfono, descarta los que ya tienen ficha y
 * da de alta al resto con sus datos reales:
 *   - nombre y dirección del pedido MÁS RECIENTE (es el dato más fresco),
 *   - totalPedidos y totalGastado sumados de todo su historial,
 *   - puntos por cashback del 1.2% de lo gastado,
 *   - zona de envío buscada en el catálogo de colonias del panel (ColoniaEnvio,
 *     la fuente de verdad actual) y, si ahí no aparece, con los keywords viejos
 *     de utils/envioZonas.js.
 *
 * NO toca sellos, racha ni wallet: esos dependen de en qué semana se hizo cada
 * compra y reconstruirlos a destiempo daría premios que no tocan. Empiezan en
 * cero y se acumulan con sus próximos pedidos.
 *
 * Uso:
 *   node scripts/recuperarClientesSinFicha.js          -> DRY RUN (solo muestra)
 *   APPLY=1 node scripts/recuperarClientesSinFicha.js  -> aplica los cambios
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Cliente = require('../models/Clientes');
const Pedido = require('../models/Pedidos');
const ColoniaEnvio = require('../models/ColoniaEnvio');
const { inferEnvioPrincipal, normalize, sufijoNombre } = require('../utils/envioZonas');

dotenv.config();

const DRY_RUN = process.env.APPLY !== '1';
const CASHBACK_RATE = 0.012; // el mismo que aplica /pedidos/new

const soloDigitos = (t) => String(t || '').replace(/\D/g, '').slice(-10);

// El catálogo de colonias del panel (ColoniaEnvio) reemplazó a los keywords
// hardcodeados de utils/envioZonas.js, así que se busca ahí primero: la lista
// vieja solo cubre ~30 colonias y dejaría en $0 (envío gratis) a la mayoría.
async function cargarCatalogo() {
    const docs = await ColoniaEnvio.find({ activo: true }).select('colonia costoEnvio gratisJueves').lean();
    const porNombre = new Map();
    for (const d of docs) {
        const nom = normalize(d.colonia);
        // Un nombre de dos o tres letras haría match con cualquier dirección.
        if (nom.length < 5) continue;
        const previo = porNombre.get(nom);
        if (!previo) {
            porNombre.set(nom, { nombre: nom, costoEnvio: d.costoEnvio, gratisJueves: d.gratisJueves, ambiguo: false });
        } else if (previo.costoEnvio !== d.costoEnvio || previo.gratisJueves !== d.gratisJueves) {
            // La misma colonia en dos CP con tarifas distintas: no se adivina.
            previo.ambiguo = true;
        }
    }
    // El match más largo gana: "paseos de chavarria" antes que "chavarria".
    return [...porNombre.values()].sort((a, b) => b.nombre.length - a.nombre.length);
}

const buscarEnCatalogo = (catalogo, texto) => {
    const t = normalize(texto);
    if (!t) return null;
    return catalogo.find((c) => t.includes(c.nombre)) || null;
};

// Devuelve { costoEnvio, gratisJueves, origen }. El operador escribe la colonia
// después del " - " del nombre, así que ese sufijo es más fiable que el texto
// libre de la dirección y se busca primero.
// sufijoNombre() de utils/envioZonas corta en " - " con espacios a los lados, pero
// el operador escribe indistintamente "Nahum - Lindavista" y "Nahum- Lindavista":
// con la segunda forma el sufijo salía vacío y la colonia no se encontraba (18 de
// 68 clientes se quedaban sin zona por esto). Aquí se corta en el último guion,
// venga como venga.
const colOperador = (nombre) => {
    const s = String(nombre || '');
    const i = s.lastIndexOf('-');
    return i >= 0 ? s.slice(i + 1).trim() : '';
};

function resolverEnvio(catalogo, nombre, direccion) {
    for (const texto of [sufijoNombre(nombre), colOperador(nombre), direccion]) {
        const hit = buscarEnCatalogo(catalogo, texto);
        if (hit && !hit.ambiguo) {
            return { costoEnvio: hit.costoEnvio, gratisJueves: hit.gratisJueves, origen: 'catálogo' };
        }
        if (hit) return { origen: 'ambiguo', colonia: hit.nombre };
    }
    const zona = inferEnvioPrincipal({ nombre, direccion });
    if (zona) return { costoEnvio: zona.costoEnvio, gratisJueves: zona.gratisJueves, origen: 'keyword' };
    return { origen: 'sin identificar' };
}

async function run() {
    if (!process.env.MONGO_URL) {
        console.error('❌ Falta MONGO_URL en el .env');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URL);
    console.log(`🔌 Conectado. Modo: ${DRY_RUN ? 'DRY RUN (no escribe)' : 'APLICANDO CAMBIOS'}`);

    // 1 · Teléfonos que ya tienen ficha (normalizados a 10 dígitos: en la
    // colección conviven formatos viejos con lada o con espacios).
    const catalogo = await cargarCatalogo();
    console.log(`🗺️  Colonias en el catálogo del panel: ${catalogo.length}`);

    const clientes = await Cliente.find().select('telefono').lean();
    const conFicha = new Set(clientes.map((c) => soloDigitos(c.telefono)).filter(Boolean));
    console.log(`👥 Clientes con ficha: ${conFicha.size}`);

    // 2 · Historial de pedidos agrupado por teléfono.
    // .lean(): son miles de pedidos y solo se leen cinco campos; como documentos
    // de Mongoose el proceso se queda sin memoria.
    const pedidos = await Pedido.find()
        .select('cliente telefono direccion total fecha createdAt')
        .sort({ createdAt: 1 })
        .lean();
    console.log(`🧾 Pedidos revisados: ${pedidos.length}`);

    const porTelefono = new Map();
    let sinTelefono = 0;
    for (const p of pedidos) {
        const tel = soloDigitos(p.telefono);
        if (tel.length !== 10) { sinTelefono++; continue; }
        if (conFicha.has(tel)) continue;

        const previo = porTelefono.get(tel);
        if (previo) {
            previo.totalPedidos += 1;
            previo.totalGastado += Number(p.total) || 0;
            // Los pedidos vienen ordenados por fecha: el último gana en nombre
            // y dirección (es como el cliente se llama y vive hoy).
            if ((p.cliente || '').trim()) previo.nombre = p.cliente.trim();
            if ((p.direccion || '').trim()) previo.direccion = p.direccion.trim();
            previo.ultimo = p.createdAt;
        } else {
            porTelefono.set(tel, {
                telefono: tel,
                nombre: (p.cliente || '').trim(),
                direccion: (p.direccion || '').trim(),
                totalPedidos: 1,
                totalGastado: Number(p.total) || 0,
                primero: p.createdAt,
                ultimo: p.createdAt,
            });
        }
    }

    const candidatos = [...porTelefono.values()];
    const incompletos = candidatos.filter((c) => !c.nombre || !c.direccion);
    const altas = candidatos.filter((c) => c.nombre && c.direccion);

    console.log(`\n📋 Teléfonos con pedidos pero sin ficha: ${candidatos.length}`);
    console.log(`   ✅ Se pueden dar de alta: ${altas.length}`);
    console.log(`   ⚠️  Sin nombre o dirección (se omiten): ${incompletos.length}`);
    if (sinTelefono) console.log(`   ⚠️  Pedidos con teléfono inválido: ${sinTelefono}`);

    let creados = 0;
    let fallidos = 0;
    const porOrigen = {};

    for (const c of altas) {
        const puntos = Math.round(c.totalGastado * CASHBACK_RATE);
        const zona = resolverEnvio(catalogo, c.nombre, c.direccion);
        porOrigen[zona.origen] = (porOrigen[zona.origen] || 0) + 1;

        const envioTxt = zona.costoEnvio != null
            ? `envío $${zona.costoEnvio}${zona.gratisJueves ? ' (gratis jueves)' : ''} [${zona.origen}]`
            : (zona.origen === 'ambiguo'
                ? `envío SIN DEFINIR ("${zona.colonia}" tiene tarifas distintas por CP)`
                : 'envío sin identificar');

        console.log(
            `   • ${c.nombre} (${c.telefono}) — ${c.totalPedidos} pedido(s), ` +
            `$${c.totalGastado.toLocaleString('es-MX')}, ${puntos} pts, ${envioTxt}`,
        );

        if (DRY_RUN) continue;

        try {
            await new Cliente({
                nombre: c.nombre,
                telefono: c.telefono,
                direccion: c.direccion,
                costoEnvio: zona.costoEnvio || 0,
                gratisJueves: zona.gratisJueves === true,
                totalPedidos: c.totalPedidos,
                totalGastado: c.totalGastado,
                puntos,
                misDirecciones: [{
                    alias: 'Dirección Principal',
                    direccion: c.direccion,
                    gpsLink: '',
                    costoEnvio: zona.costoEnvio || 0,
                    gratisJueves: zona.gratisJueves === true,
                }],
            }).save();
            creados++;
        } catch (err) {
            // Un duplicado aquí significa que el teléfono ya existía con otro
            // formato: se deja para revisar a mano en vez de tocar la ficha buena.
            fallidos++;
            console.warn(`     ⚠️  No se pudo crear (${c.telefono}): ${err.message}`);
        }
    }

    console.log(`\n🚚 Envío resuelto: ` + Object.entries(porOrigen).map(([k, v]) => `${k}: ${v}`).join(' · '));

    console.log(
        DRY_RUN
            ? `\n⚠️  DRY RUN: no se escribió nada. Corre con  APPLY=1 node scripts/recuperarClientesSinFicha.js  para aplicar.`
            : `\n✅ Clientes creados: ${creados}${fallidos ? ` · con problemas: ${fallidos}` : ''}`,
    );

    await mongoose.disconnect();
    process.exit(0);
}

run().catch((err) => {
    console.error('❌ Error:', err);
    process.exit(1);
});
