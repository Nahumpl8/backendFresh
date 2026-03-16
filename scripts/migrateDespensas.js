/**
 * Script de migración: Despensas products de texto → referencia a Product._id
 *
 * Ejecutar desde la raíz del proyecto:
 *   node scripts/migrateDespensas.js          (dry-run)
 *   node scripts/migrateDespensas.js --apply  (guardar cambios)
 *   node scripts/migrateDespensas.js --debug  (ver detalle de matching)
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URL = process.env.MONGO_URL;
if (!MONGO_URL) {
  console.error('❌ Falta MONGO_URL en .env');
  process.exit(1);
}

const applyChanges = process.argv.includes('--apply');
const debug = process.argv.includes('--debug');

// ================ HELPERS ================

// Extraer nombre limpio del título del producto
// "500g de Tilapia $95" → "Tilapia"
// "1 Pza de Crema Alpura 450ml $40" → "Crema Alpura 450ml"
// "500gr Hígado de res $60" → "Hígado de res"
function extractNameFromTitle(title) {
  let t = (title || '').trim();
  // Remove price suffix: " $95", " $1,012", "$95"
  t = t.replace(/\s*\$[\d,.\s]+$/, '').trim();
  // Remove trailing "PENDIENTE PRECIO"
  t = t.replace(/\s*PENDIENTE PRECIO\s*$/i, '').trim();
  // Remove leading PROMO/Cupón/CUPON/SEPARAR prefixes
  t = t.replace(/^(PROMO|Cupón|CUPON)\s+(de\s+)?/i, '');
  // Remove leading quantity+unit+de: "500g de ", "1 Pza de ", "1kg de ", "1 lata de "
  t = t.replace(/^\d+(\.\d+)?\s*(g|gr|kg|pza|pzas|pieza|piezas|lt|ml|lata|latas|media|medias|penca|Paquete)\s*(de\s+\d+\w+\s+)?(de\s+)?/i, '');
  // Also handle "1 caja de 12Lt ..." → "..."
  t = t.replace(/^\d+\s+caja\s+de\s+\d+\w*\s+/i, '');
  // Handle "1 pza. de ..."
  t = t.replace(/^\d+\s+pza?\.\s*(de\s+)?/i, '');
  // Handle "1 paq de ..."
  t = t.replace(/^\d+\s+paq\s+(de\s+)?/i, '');
  return t.trim();
}

// Normalizar nombre de despensa: strip qty prefix
function normalizeDespensaName(nombre) {
  let n = (nombre || '').trim();
  // "500gr Arrachera de res" → "Arrachera de res"
  n = n.replace(/^\d+(\.\d+)?\s*(g|gr|kg|pza|pzas|pieza|piezas|lt|ml|lata|media|medias|penca)\s+/i, '');
  // "1 pza Brocoli" → "Brocoli"
  n = n.replace(/^\d+\s+(pza|pzas|pieza|piezas|media|medias)\s+/i, '');
  // "1kg Milanesa" → "Milanesa"
  n = n.replace(/^\d+\s*kg\s+/i, '');
  // "2 Medias pechugas" → "pechugas"
  n = n.replace(/^\d+\s+/i, '');
  return n.trim();
}

// Alias manuales: nombre normalizado → nombre como aparece en titulo del Product
const ALIASES = {
  'jamon': ['Jamón pavo FUD', 'Jamón económico'],
  'huevo': ['Huevo PORTALES', 'huevo PORTALES', 'Huevo SAN JUAN'],
  'tocino': ['Tocino Ahumado'],
  'cebolla': ['Cebolla blanca', 'Cebolla morada'],
  'sopa': ['Sopa Moderna'],
  'picana de res': ['Picaña'],
  'media pechuga aplanada': ['pechuga aplanada', 'pechugas aplanadas'],
  'media pechuga en trozo': ['pechuga trozo', 'pechugas trozo'],
  'medias pechugas aplanadas': ['pechugas aplanadas', 'pechuga aplanada'],
  'brocoli': ['Brócoli'],
  'lechuga romana': ['Lechuga italiana'],
  'bisteces de res': ['Bistec Res'],
  'aguja de res': ['Aguja de res para asar'],
  'chile jalapeno': ['Chile jalapeño'],
  'jicama': ['jícama'],
  'new york': ['Top Sirloin'],
  'queso canasto': ['Queso Canasto', 'Queso canasto'],
  'queso oaxaca': ['Queso Oaxaca'],
  'media pechuga de pollo aplanada': ['pechuga aplanada', 'pechugas aplanadas'],
  'media pechuga de pollo en trozo': ['pechuga trozo', 'pechugas trozo'],
  'crema alpura chica': ['Crema Alpura 200ml'],
  'espaguetti': ['Espagueti Moderna'],
  'surumi': ['Surimi'],
  'salchicha de pavo': ['Salchicha pavo económica'],
  'salchicha': ['Salchicha pavo económica'],
};

async function main() {
  console.log(`\n🔄 Migración de Despensas → Product references`);
  console.log(`   Modo: ${applyChanges ? '⚡ APLICAR CAMBIOS' : '🔍 DRY RUN (usar --apply para guardar)'}\n`);

  await mongoose.connect(MONGO_URL);
  console.log('✅ Conectado a MongoDB\n');

  const db = mongoose.connection.db;

  // Load all products RAW (sin schema)
  const allProducts = await db.collection('products').find({}).toArray();
  console.log(`📦 ${allProducts.length} productos en catálogo\n`);

  // Build index: extracted name (lowercase) → [products]
  const productIndex = {};
  for (const p of allProducts) {
    const extractedName = extractNameFromTitle(p.title);
    const key = extractedName.toLowerCase().trim();
    if (key.length === 0) continue;
    if (!productIndex[key]) productIndex[key] = [];
    productIndex[key].push({ ...p, _extractedName: extractedName });
  }

  if (debug) {
    console.log('🔍 Muestra del índice (primeros 30):');
    const keys = Object.keys(productIndex).sort().slice(0, 30);
    keys.forEach(k => console.log(`   "${k}" → ${productIndex[k].length} products`));
    console.log(`   ... (${Object.keys(productIndex).length} keys total)\n`);
  }

  // Load despensas raw
  const despensasCol = db.collection('despensas');
  const despensas = await despensasCol.find({}).toArray();

  let totalProducts = 0;
  let matched = 0;
  let unmatched = 0;
  const unmatchedList = [];

  for (const despensa of despensas) {
    console.log(`\n📋 ${despensa.name} (${despensa.products?.length || 0} productos)`);

    if (!despensa.products || despensa.products.length === 0) {
      console.log('   (sin productos, skip)');
      continue;
    }

    const newProducts = [];

    for (const prod of despensa.products) {
      totalProducts++;
      const rawName = (prod.nombre || '').trim();
      const normalized = normalizeDespensaName(rawName);
      const searchKey = normalized.toLowerCase().trim();

      if (debug) {
        console.log(`\n   🔍 "${rawName}" → normalized: "${normalized}" → key: "${searchKey}"`);
      }

      let matchedProduct = null;
      let matchMethod = '';

      // Step 1: Check aliases
      if (ALIASES[searchKey]) {
        for (const aliasTarget of ALIASES[searchKey]) {
          const aliasKey = aliasTarget.toLowerCase().trim();
          const candidates = productIndex[aliasKey] || [];
          if (candidates.length > 0) {
            matchedProduct = pickBestMatch(candidates, prod.precio);
            matchMethod = `alias→"${aliasTarget}"`;
            break;
          }
        }
        if (debug) console.log(`   alias: ${matchedProduct ? '✓' : '✗'}`);
      }

      // Step 2: Exact match
      if (!matchedProduct) {
        const candidates = productIndex[searchKey] || [];
        if (candidates.length > 0) {
          matchedProduct = pickBestMatch(candidates, prod.precio);
          matchMethod = 'exact';
        }
        if (debug) console.log(`   exact "${searchKey}": ${(productIndex[searchKey] || []).length} candidates`);
      }

      // Step 3: Fuzzy — product index key contains searchKey or vice versa
      if (!matchedProduct && searchKey.length >= 4) {
        const fuzzy = [];
        for (const [key, products] of Object.entries(productIndex)) {
          if (key.length < 3) continue;
          if (key.includes(searchKey) || searchKey.includes(key)) {
            fuzzy.push(...products);
          }
        }
        if (fuzzy.length > 0) {
          matchedProduct = pickBestMatch(fuzzy, prod.precio);
          matchMethod = 'fuzzy';
        }
        if (debug) console.log(`   fuzzy: ${fuzzy.length} candidates`);
      }

      if (matchedProduct) {
        matched++;
        console.log(`   ✅ "${rawName}" → [${matchMethod}] ${matchedProduct.title} (${matchedProduct._id})`);
        newProducts.push({
          productId: matchedProduct._id,
          cantidad: Number(prod.cantidad) || 1,
          unidad: prod.unidad || 'pza'
        });
      } else {
        unmatched++;
        unmatchedList.push({ despensa: despensa.name, nombre: rawName, precio: prod.precio });
        console.log(`   ❌ "${rawName}" → SIN MATCH (key: "${searchKey}")`);
      }
    }

    if (applyChanges && newProducts.length > 0) {
      await despensasCol.updateOne(
        { _id: despensa._id },
        { $set: { products: newProducts } }
      );
      console.log(`   💾 Guardado (${newProducts.length} productos)`);
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log(`📊 RESUMEN`);
  console.log(`   Total productos: ${totalProducts}`);
  console.log(`   ✅ Matched: ${matched}`);
  console.log(`   ❌ Unmatched: ${unmatched}`);

  if (unmatchedList.length > 0) {
    console.log('\n⚠️  Productos sin match:');
    for (const u of unmatchedList) {
      console.log(`   - [${u.despensa}] "${u.nombre}" ($${u.precio})`);
    }
  }

  // Also populate nombreSinUnidades for all products
  if (applyChanges) {
    console.log('\n📝 Poblando nombreSinUnidades en todos los productos...');
    let updated = 0;
    for (const p of allProducts) {
      const name = extractNameFromTitle(p.title);
      if (name && name !== (p.nombreSinUnidades || '')) {
        await db.collection('products').updateOne(
          { _id: p._id },
          { $set: { nombreSinUnidades: name } }
        );
        updated++;
      }
    }
    console.log(`   ✅ ${updated} productos actualizados con nombreSinUnidades`);
  }

  if (!applyChanges && unmatched === 0) {
    console.log('\n💡 Todo matcheó! Para aplicar: node scripts/migrateDespensas.js --apply');
  } else if (!applyChanges) {
    console.log('\n💡 Revisa los unmatched, luego: node scripts/migrateDespensas.js --apply');
  }

  await mongoose.disconnect();
  console.log('\n🔌 Desconectado\n');
}

function pickBestMatch(candidates, targetPrice) {
  if (candidates.length === 1) return candidates[0];
  const price = Number(targetPrice) || 0;
  return candidates.reduce((best, c) => {
    const bestDiff = Math.abs((best.price || 0) - price);
    const currDiff = Math.abs((c.price || 0) - price);
    return currDiff < bestDiff ? c : best;
  });
}

main().catch(err => {
  console.error('💥 Error:', err);
  process.exit(1);
});
