/**
 * Ubicaciones para acomodar rutas, sin servicios externos.
 *
 * - Las coordenadas salen de los enlaces de Google Maps que los clientes ya
 *   compartieron (casi siempre cortos, maps.app.goo.gl): se sigue el enlace hasta
 *   la URL final y de ahí se leen. Lo encontrado se guarda en GeoCache.
 * - El orden de las paradas se calcula aquí mismo, por distancia: primero la más
 *   cercana cada vez y luego se deshacen los cruces del recorrido (2-opt), con la
 *   salida y la llegada fijas. No usa calles reales: los km son aproximados.
 */
const axiosMod = require('axios');
const axios = axiosMod.default || axiosMod;
const mongoose = require('mongoose');

const GeoCacheSchema = new mongoose.Schema({
    clave: { type: String, required: true, unique: true },   // el enlace
    lat: Number,
    lng: Number,
}, { timestamps: true });
const GeoCache = mongoose.models.GeoCache || mongoose.model('GeoCache', GeoCacheSchema);

// Caja alrededor de Pachuca y Mineral de la Reforma: lo que caiga fuera se descarta.
const CAJA = { latMin: 19.95, latMax: 20.25, lngMin: -98.95, lngMax: -98.6 };
const enCaja = (p) => p && p.lat > CAJA.latMin && p.lat < CAJA.latMax && p.lng > CAJA.lngMin && p.lng < CAJA.lngMax;
const FACTOR_CALLES = 1.35;   // las calles no van en línea recta: km aproximados

/** Coordenadas escritas en un texto o URL ("20.12,-98.74", ?q=…, @…, !3d…!4d…). */
function coordsDeTexto(texto) {
    let s = String(texto || '');
    try { s = decodeURIComponent(s); } catch (_) { /* texto con % suelto */ }
    const m = s.match(/[?&](?:q|ll|query|destination|daddr)=(-?\d{1,2}\.\d+),\s*(-?\d{2,3}\.\d+)/)
        || s.match(/@(-?\d{1,2}\.\d+),(-?\d{2,3}\.\d+)/)
        || s.match(/!3d(-?\d{1,2}\.\d+)!4d(-?\d{2,3}\.\d+)/)
        || s.match(/^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{2,3}\.\d+)\s*$/);
    const p = m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
    return enCaja(p) ? p : null;
}

async function seguirEnlace(url) {
    let u = url;
    for (let i = 0; i < 5; i++) {
        const r = await axios.get(u, { maxRedirects: 0, validateStatus: () => true, timeout: 10000 });
        if (r.status >= 300 && r.status < 400 && r.headers.location) { u = new URL(r.headers.location, u).toString(); continue; }
        return u;
    }
    return u;
}

const esEnlaceGoogle = (u) => /^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|(www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)/i.test(u);

/** Ubicación de un enlace de Google Maps o de un texto "lat,lng". Solo consulta a Google. */
async function deEnlace(enlace) {
    const e = String(enlace || '').trim();
    if (!e) return null;
    const directo = coordsDeTexto(e);
    if (directo) return directo;
    if (!esEnlaceGoogle(e)) return null;
    const c = await GeoCache.findOne({ clave: e }).lean();
    if (c) return c.lat != null ? { lat: c.lat, lng: c.lng } : null;
    let p = null;
    try { p = coordsDeTexto(await seguirEnlace(e)); } catch (_) { return null; }   // error de red: no se guarda, se reintenta después
    await GeoCache.updateOne({ clave: e }, { $set: { lat: p ? p.lat : null, lng: p ? p.lng : null } }, { upsert: true }).catch(() => {});
    return p;
}

const radianes = (g) => (g * Math.PI) / 180;
function distanciaKm(a, b) {
    const dLat = radianes(b.lat - a.lat), dLng = radianes(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(radianes(a.lat)) * Math.cos(radianes(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const largo = (camino) => camino.slice(1).reduce((s, p, i) => s + distanciaKm(camino[i], p), 0);

/**
 * Orden de visita de `puntos` ([{lat,lng}]) de `salida` a `llegada`.
 * Devuelve { orden: [índices de puntos], km } (km aproximados por calles).
 */
function ordenarParadas(puntos, salida, llegada) {
    const n = puntos.length;
    if (!n) return { orden: [], km: null };

    // 1. La más cercana cada vez, desde la salida.
    const quedan = puntos.map((p, i) => ({ ...p, i }));
    const camino = [{ ...salida, i: -1 }];
    while (quedan.length) {
        const actual = camino[camino.length - 1];
        let mejor = 0;
        for (let j = 1; j < quedan.length; j++) if (distanciaKm(actual, quedan[j]) < distanciaKm(actual, quedan[mejor])) mejor = j;
        camino.push(quedan.splice(mejor, 1)[0]);
    }
    camino.push({ ...llegada, i: -2 });

    // 2. 2-opt: invertir tramos mientras acorte el recorrido (salida y llegada no se mueven).
    let mejoro = true;
    for (let vuelta = 0; mejoro && vuelta < 50; vuelta++) {
        mejoro = false;
        for (let a = 1; a < camino.length - 2; a++) {
            for (let b = a + 1; b < camino.length - 1; b++) {
                const antes = distanciaKm(camino[a - 1], camino[a]) + distanciaKm(camino[b], camino[b + 1]);
                const despues = distanciaKm(camino[a - 1], camino[b]) + distanciaKm(camino[a], camino[b + 1]);
                if (despues + 1e-9 < antes) {
                    const tramo = camino.slice(a, b + 1).reverse();
                    camino.splice(a, tramo.length, ...tramo);
                    mejoro = true;
                }
            }
        }
    }
    return {
        orden: camino.slice(1, -1).map((p) => p.i),
        km: Math.round(largo(camino) * FACTOR_CALLES * 10) / 10,
    };
}

module.exports = { deEnlace, ordenarParadas, coordsDeTexto, distanciaKm };
