function extractNameFromTitle(title) {
  let t = (title || '').trim();
  t = t.replace(/\s*\$[\d,.\s]+$/, '').trim();
  t = t.replace(/\s*PENDIENTE PRECIO\s*$/i, '').trim();
  t = t.replace(/^(PROMO|Cupón|CUPON)\s+(de\s+)?/i, '');
  t = t.replace(/^\d+(\.\d+)?\s*(pzas|pza|piezas|pieza|latas|lata|medias|media|gr|g|kg|lt|ml|penca|Paquete)\s*(de\s+\d+\w+\s+)?(de\s+)?/i, '');
  t = t.replace(/^\d+\s+caja\s+de\s+\d+\w*\s+/i, '');
  t = t.replace(/^\d+\s+pza?\.\s*(de\s+)?/i, '');
  t = t.replace(/^\d+\s+paq\s+(de\s+)?/i, '');
  return t.trim();
}

module.exports = { extractNameFromTitle };
