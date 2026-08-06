function extractNameFromTitle(title) {
  let t = (title || '').trim();
  t = t.replace(/\s*\$[\d,.\s]+$/, '').trim();
  t = t.replace(/\s*PENDIENTE PRECIO\s*$/i, '').trim();
  t = t.replace(/^(PROMO|Cupón|CUPON)\s+(de\s+)?/i, '');
  // Unidades ordenadas longest-first cuando comparten prefijo (gramos antes de gr antes de g, etc.)
  // para no cortar a la mitad ("500 gramos" -> "gramos", no "amos").
  t = t.replace(/^\d+(\.\d+)?\s*(pzas|pza|piezas|pieza|latas|lata|medias|media|medio|gramos|gr|g|kilos|kilo|kg|litros|litro|lts|lt|ml|pencas|penca|paquete|rebanadas|rebanada|reb|rollos|rollo|manojos|manojo|charolas|charola|bolsas|bolsa|casilleros|casillero|domos|domo)\s*(de\s+\d+\w+\s+)?(de\s+)?/i, '');
  t = t.replace(/^\d+\s+caja\s+de\s+\d+\w*\s+/i, '');
  t = t.replace(/^\d+\s+pza?\.\s*(de\s+)?/i, '');
  t = t.replace(/^\d+\s+paq\s+(de\s+)?/i, '');
  return t.trim();
}

module.exports = { extractNameFromTitle };
