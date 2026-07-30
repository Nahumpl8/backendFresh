/**
 * Fundación de IA (Fase 0): wrapper único sobre el SDK de Anthropic (Claude).
 * La ANTHROPIC_API_KEY se lee del entorno (Railway). NUNCA en frontends.
 */
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic(); // lee ANTHROPIC_API_KEY del env
// Haiku 4.5: barato y con buena visión para leer capturas. (Subir a sonnet/opus si una
// feature necesita más precisión.) OJO: Haiku 4.5 NO soporta adaptive thinking ni effort.
const MODEL = 'claude-haiku-4-5';

/**
 * Llama a Claude con visión (imágenes) y/o texto y devuelve JSON validado por schema.
 * @param {Object} p
 * @param {Array<{dataBase64:string, mediaType?:string}>} [p.images]
 * @param {string} [p.text]           Texto del usuario (contexto)
 * @param {string} [p.systemPrompt]   Instrucciones del sistema
 * @param {Object} [p.schema]         JSON Schema para structured outputs
 * @returns {Promise<{data:any, raw:string, usage:any}>}
 */
async function askVision({ images = [], text = '', systemPrompt = '', schema } = {}) {
    const content = [];
    for (const img of images) {
        if (!img || !img.dataBase64) continue;
        content.push({
            type: 'image',
            source: {
                type: 'base64',
                media_type: img.mediaType || 'image/jpeg',
                data: img.dataBase64,
            },
        });
    }
    if (text) content.push({ type: 'text', text });
    if (content.length === 0) throw new Error('Se requiere al menos una imagen o texto.');

    const req = {
        model: MODEL,
        max_tokens: 16000,
        // Sin 'thinking': Haiku 4.5 no soporta adaptive; para extracción estructurada no
        // hace falta razonar largo y así abaratamos los tokens de salida.
        messages: [{ role: 'user', content }],
    };
    if (systemPrompt) req.system = systemPrompt;
    if (schema) req.output_config = { format: { type: 'json_schema', schema } };

    const resp = await client.messages.create(req);

    // Control de costo: log de tokens
    try { console.log('🤖 IA usage:', JSON.stringify(resp.usage)); } catch (_) {}

    if (resp.stop_reason === 'refusal') {
        throw new Error('La IA rechazó la solicitud (refusal).');
    }

    const textBlock = (resp.content || []).find((b) => b.type === 'text');
    const raw = textBlock ? textBlock.text : '';

    let data = null;
    if (schema) {
        try {
            data = JSON.parse(raw);
        } catch (e) {
            throw new Error('La respuesta de la IA no es JSON válido: ' + raw.slice(0, 200));
        }
    }
    return { data, raw, usage: resp.usage };
}

module.exports = { client, MODEL, askVision };
