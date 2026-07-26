/**
 * Zonas de envío de Fresh Market: única fuente de verdad.
 * Usado por el backfill (scripts/backfillEnvio.js), el hook de creación de cliente
 * (models/Clientes.js) y el endpoint add-address (routes/clientes.js).
 *
 * Regla: zonas AZULES => gratis los jueves, cobran otros días (gratisJueves=true).
 *        zonas AMARILLAS => cobran siempre (gratisJueves=false).
 */

// Normaliza: minúsculas, sin acentos/ñ, signos -> espacio, espacios colapsados.
const normalize = (s) =>
    String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

// keyword -> { costoEnvio, gratisJueves }. Se evalúan en orden; primer match gana.
const ZONAS_RAW = [
    // AZUL: $35, gratis los jueves
    { keyword: 'pachuquilla', costoEnvio: 35, gratisJueves: true },
    { keyword: 'virreyes', costoEnvio: 35, gratisJueves: true },
    { keyword: 'la calera', costoEnvio: 35, gratisJueves: true },
    { keyword: 'nopalapa', costoEnvio: 35, gratisJueves: true },
    { keyword: 'rinconada de los angeles', costoEnvio: 35, gratisJueves: true },
    { keyword: 'xochihuacan', costoEnvio: 35, gratisJueves: true },
    { keyword: 'hacienda margarita', costoEnvio: 35, gratisJueves: true },
    { keyword: 'hda margarita', costoEnvio: 35, gratisJueves: true },
    { keyword: 'margarita', costoEnvio: 35, gratisJueves: true },
    { keyword: 'real madeira', costoEnvio: 35, gratisJueves: true },
    { keyword: 'lindavista', costoEnvio: 35, gratisJueves: true },
    { keyword: 'santa matilde', costoEnvio: 35, gratisJueves: true },
    { keyword: 'matilde', costoEnvio: 35, gratisJueves: true },
    { keyword: 'vinedos', costoEnvio: 35, gratisJueves: true },
    { keyword: 'san alfonso', costoEnvio: 35, gratisJueves: true },
    { keyword: 'amores de don juan', costoEnvio: 35, gratisJueves: true },
    { keyword: 'real navarra', costoEnvio: 35, gratisJueves: true },

    // AMARILLO: $25, siempre se cobra
    { keyword: 'renacimiento', costoEnvio: 25, gratisJueves: false },
    { keyword: 'antorcha', costoEnvio: 25, gratisJueves: false },
    { keyword: 'los pirules', costoEnvio: 25, gratisJueves: false },
    { keyword: 'crisol', costoEnvio: 25, gratisJueves: false },
    { keyword: 'aves del paraiso', costoEnvio: 25, gratisJueves: false },

    // AMARILLO: $40, siempre se cobra
    { keyword: 'loma bonita', costoEnvio: 40, gratisJueves: false },
    { keyword: 'la loma', costoEnvio: 40, gratisJueves: false },
    { keyword: 'barrio del judio', costoEnvio: 40, gratisJueves: false },
    { keyword: 'banus', costoEnvio: 40, gratisJueves: false },
    { keyword: 'universidad del futbol', costoEnvio: 40, gratisJueves: false },
    { keyword: 'paseo de solares', costoEnvio: 40, gratisJueves: false },
    { keyword: 'la concepcion', costoEnvio: 40, gratisJueves: false },
    { keyword: 'san guillermo la reforma', costoEnvio: 40, gratisJueves: false },
    { keyword: 'san guillermo', costoEnvio: 40, gratisJueves: false },
    { keyword: 'azoyotla de ocampo', costoEnvio: 40, gratisJueves: false },
    { keyword: 'azoyotla', costoEnvio: 40, gratisJueves: false },
    { keyword: 'mirador', costoEnvio: 40, gratisJueves: false },
];

const ZONAS = ZONAS_RAW.map((z) => ({ ...z, keyword: normalize(z.keyword) }));

// Primera zona cuyo keyword aparezca como substring del texto, o null.
const matchZona = (texto) => {
    const t = normalize(texto);
    if (!t) return null;
    for (const z of ZONAS) {
        if (z.keyword && t.includes(z.keyword)) {
            return { costoEnvio: z.costoEnvio, gratisJueves: z.gratisJueves, keyword: z.keyword };
        }
    }
    return null;
};

// Sufijo del nombre tras el último " - " (ej. "Nahum Pérez - Lindavista" -> "Lindavista")
const sufijoNombre = (nombre) => {
    const s = String(nombre || '');
    const idx = s.lastIndexOf(' - ');
    return idx >= 0 ? s.slice(idx + 3) : '';
};

// Infiere el envío de la dirección PRINCIPAL usando el sufijo del nombre + la dirección.
const inferEnvioPrincipal = ({ nombre, direccion }) =>
    matchZona(`${sufijoNombre(nombre)} ${direccion || ''}`);

// Infiere el envío de una dirección de misDirecciones usando alias + dirección.
const inferEnvioDireccion = ({ alias, direccion }) =>
    matchZona(`${alias || ''} ${direccion || ''}`);

module.exports = {
    normalize,
    matchZona,
    sufijoNombre,
    inferEnvioPrincipal,
    inferEnvioDireccion,
};
