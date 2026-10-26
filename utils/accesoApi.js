/**
 * Acceso a la API: protegido por defecto.
 *
 * Toda ruta /api/* exige token de admin SALVO las de la lista PUBLICAS. Así un
 * endpoint nuevo nace cerrado: para abrirlo hay que añadirlo aquí a propósito.
 *
 * AUTH_MODO:
 *   'observar' (por defecto) → no bloquea nada; registra en logs lo que bloquearía.
 *   'bloquear'               → responde 401.
 * Rollback inmediato: volver a 'observar' en Railway.
 *
 * La lista sale de revisar el código de la tienda, el panel y la app de
 * repartidores (docs/plan-seguridad-sabado.md).
 */
const { leerAdmin } = require('./adminMiddleware');
const { leerRepartidor } = require('./repartidorAuth');

const P = (metodo, patron, quien) => ({ metodo, re: new RegExp(`^${patron}/?$`), quien });
const ID = '[^/]+';

const PUBLICAS = [
    // --- Tienda: catálogo y configuración ---
    P('GET', '/api/products', 'tienda'),
    P('GET', `/api/products/find/${ID}`, 'catálogo'),
    P('GET', '/api/products/mas-vendidos', 'tienda: orden del catálogo'),
    P('GET', '/api/despensas', 'tienda'),
    P('GET', `/api/despensas/find/${ID}`, 'catálogo'),
    P('GET', '/api/app-config', 'tienda'),
    P('GET', '/api/promociones/activas', 'tienda'),
    P('GET', `/api/colonias-envio/cp/${ID}`, 'tienda'),
    P('GET', '/api/pedidos/rifa-ranking', 'tienda'),

    // --- Tienda: cuenta del cliente (se autentica con su PIN) ---
    P('POST', '/api/clientes/buscar', 'tienda'),
    P('POST', '/api/clientes/new', 'tienda'),
    P('POST', '/api/clientes/guardar-email', 'tienda'),
    P('POST', '/api/clientes-auth/(setup-pin|login|forgot-pin|reset-pin)', 'tienda'),
    P('PUT', '/api/clientes-auth/update-email', 'tienda (PIN)'),
    P('POST', '/api/clientes-auth/telegram/(link-token|desvincular)', 'tienda (JWT de cliente)'),

    // --- Tienda: perfil y checkout. Fase 2: exigir el token del cliente ---
    P('GET', `/api/clientes/detalle/${ID}`, 'tienda'),
    P('PUT', `/api/clientes/edit/${ID}`, 'tienda (campos limitados sin admin)'),
    P('PUT', `/api/clientes/add-address/${ID}`, 'tienda'),
    P('GET', `/api/pedidos/cliente/${ID}`, 'tienda'),

    // --- Pedidos ---
    P('POST', '/api/pedidos/new', 'tienda'),
    P('POST', '/api/pedidos/confirmacion', 'tienda'),

    // --- Wallet: enlaces de descarga y Apple PassKit (HMAC propio) ---
    P('GET', `/api/wallet/download/apple/${ID}`, 'clientes'),
    P('GET', `/api/wallet/(google|go)/${ID}`, 'clientes'),
    P('(GET|POST|DELETE)', '/api/wallet/v1/.+', 'Apple'),

    // --- Login de admins ---
    P('POST', '/api/admin/(login|primer-acceso|olvide|restablecer)', 'login'),

    // --- Lista de nombres para el selector de la app de repartidores ---
    P('GET', '/api/repartidores', 'repartidores (solo nombres)'),
    P('POST', '/api/repartidores/login', 'repartidores (PIN)'),
];

// Lo que usa la app de repartidores: con token de repartidor (o de admin).
const REPARTIDOR = [
    P('GET', '/api/rutas/hoy', 'repartidor'),
    P('PATCH', `/api/rutas/${ID}/pedido/${ID}`, 'repartidor'),
    P('POST', `/api/rutas/${ID}/cerrar`, 'repartidor'),
    P('GET', '/api/clientes/lite', 'repartidor'),
    P('GET', `/api/clientes/find/${ID}`, 'repartidor'),
];

const coincide = (lista, metodo, ruta) =>
    lista.some((p) => new RegExp(`^(${p.metodo})$`).test(metodo) && p.re.test(ruta));
// Mientras la app de repartidores no tenga PIN publicado, sus rutas siguen
// abiertas. REPARTIDORES_ABIERTO=false las cierra (sábado 17 oct, noche).
const repartidoresAbierto = () => String(process.env.REPARTIDORES_ABIERTO || '').toLowerCase() !== 'false';
const esPublica = (metodo, ruta) =>
    coincide(PUBLICAS, metodo, ruta) || (repartidoresAbierto() && coincide(REPARTIDOR, metodo, ruta));

const bloquea = () => String(process.env.AUTH_MODO || '').toLowerCase() === 'bloquear';

// En modo observar, una línea por ruta cada 10 min (sin inundar los logs).
const avisados = new Map();
const normalizar = (ruta) => ruta.replace(/\/[a-f0-9]{24}\b/gi, '/:id').replace(/\/\d{6,}\b/g, '/:num');
function avisar(req) {
    const clave = `${req.method} ${normalizar(req.path)}`;
    const antes = avisados.get(clave);
    if (antes && Date.now() - antes < 10 * 60 * 1000) return;
    avisados.set(clave, Date.now());
    console.log(`🔒 [observar] bloquearía ${clave} (sin token de admin) origen=${req.get('origin') || '-'}`);
}

async function accesoApi(req, res, next) {
    if (req.method === 'OPTIONS') return next();
    const ruta = req.baseUrl + req.path;
    try {
        if (req.headers.authorization) {
            const admin = await leerAdmin(req);
            if (admin) { req.admin = admin; return next(); }
            if (coincide(REPARTIDOR, req.method, ruta)) {
                const rep = await leerRepartidor(req);
                if (rep) { req.repartidor = rep; return next(); }
            }
        }
        if (esPublica(req.method, ruta)) return next();
        if (!bloquea()) { avisar({ method: req.method, path: ruta, get: (h) => req.get(h) }); return next(); }
        return res.status(401).json({ error: 'No autorizado' });
    } catch (e) {
        console.error('❌ accesoApi:', e.message);
        return bloquea() ? res.status(401).json({ error: 'No autorizado' }) : next();
    }
}

module.exports = { accesoApi, esPublica, PUBLICAS, REPARTIDOR };
