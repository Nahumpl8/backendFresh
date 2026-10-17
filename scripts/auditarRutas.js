/**
 * Red de seguridad: recorre TODAS las rutas montadas en Express y comprueba,
 * SIN token, que las privadas respondan 401 y las públicas no.
 *
 *   node scripts/auditarRutas.js http://localhost:4700
 *   node scripts/auditarRutas.js https://backendfresh-production.up.railway.app
 *
 * Solo tiene sentido con AUTH_MODO=bloquear en el servidor auditado.
 * Para no escribir nada:
 *   - las privadas se llaman con ids falsos y cuerpo vacío (el filtro las corta antes);
 *   - de las públicas solo se prueban los GET; los POST/PUT públicos se listan sin llamarlos.
 */
const express = require('express');
const { esPublica } = require('../utils/accesoApi');

const BASE = (process.argv[2] || 'http://localhost:4700').replace(/\/+$/, '');

// Monta los mismos routers que index.js, sin arrancar el servidor ni Mongo.
const fs = require('fs');
const path = require('path');
const indexJs = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const requires = Object.fromEntries([...indexJs.matchAll(/const (\w+) = require\('(\.\/routes\/[^']+)'\)/g)].map((m) => [m[1], m[2]]));
const montajes = [...indexJs.matchAll(/app\.use\(['"](\/api[^'"]*)['"],\s*(?:[^,)]*,\s*)?(\w+)\)/g)].map((m) => [m[1], m[2]]);

function rutasDe(router, prefijo) {
    const out = [];
    for (const capa of router.stack || []) {
        if (capa.route) {
            for (const metodo of Object.keys(capa.route.methods)) out.push([metodo.toUpperCase(), prefijo + capa.route.path]);
        }
    }
    return out;
}

const relleno = (ruta) => ruta.replace(/:(\w+)/g, (_, n) => (/tel/i.test(n) ? '5550000000' : n === 'fecha' ? '2026-01-01' : '000000000000000000000000'));

(async () => {
    const rutas = [];
    for (const [prefijo, nombre] of montajes) {
        if (!requires[nombre]) continue;
        const router = require(path.join(__dirname, '..', requires[nombre]));
        rutas.push(...rutasDe(router, prefijo));
    }
    console.log(`Auditando ${rutas.length} rutas contra ${BASE}\n`);

    const fallas = [];
    const noProbadas = [];
    for (const [metodo, ruta] of rutas) {
        const url = relleno(ruta);
        const publica = esPublica(metodo, url);
        if (publica && metodo !== 'GET') { noProbadas.push(`${metodo} ${ruta}`); continue; }
        if (publica && /\/wallet\/(download|google|go)\//.test(url)) { noProbadas.push(`${metodo} ${ruta} (genera un pase)`); continue; }
        let status;
        let cortadoPorFiltro = false;
        try {
            const r = await fetch(BASE + url, {
                method: metodo, headers: { 'content-type': 'application/json' },
                ...(metodo === 'GET' ? {} : { body: '{}' }), redirect: 'manual',
            });
            status = r.status;
            // El filtro responde {"error":"No autorizado"}; un 401 distinto es la
            // validación propia de la ruta (p. ej. la firma de Apple Wallet).
            if (status === 401) cortadoPorFiltro = (await r.text()).includes('No autorizado');
        } catch (e) { status = `error ${e.message}`; }
        const ok = publica ? !(status === 401 && cortadoPorFiltro) : status === 401;
        console.log(`${ok ? '✅' : '❌'} ${String(status).padEnd(4)} ${publica ? 'pública' : 'privada'} ${metodo.padEnd(6)} ${ruta}`);
        if (!ok) fallas.push(`${metodo} ${ruta} → ${status}`);
    }
    console.log(`\nNo probadas (públicas que escriben, se revisan a mano): ${noProbadas.length}`);
    noProbadas.forEach((r) => console.log('   · ' + r));
    console.log(fallas.length ? `\n❌ ${fallas.length} FALLAS:\n   ${fallas.join('\n   ')}` : '\n✅ Todas las rutas se comportan como deben.');
    process.exit(fallas.length ? 1 : 0);
})();
