const router = require('express').Router();
const Product = require('../models/Product');
const { verifyToken, verifyTokenAndAuthorization } = require('./verifyToken');
const { extractNameFromTitle } = require('../utils/extractName');

//CREATE

router.post('/', async (req, res) => {
    if (req.body.title && !req.body.nombreSinUnidades) {
        req.body.nombreSinUnidades = extractNameFromTitle(req.body.title);
    }
    const newProduct = new Product(req.body);

    try {
        const savedProduct = await newProduct.save();
        res.status(200).json(savedProduct);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

//UPDATE PRODUCT
router.put('/:id', async (req, res) => {
    if (req.body.title) {
        req.body.nombreSinUnidades = extractNameFromTitle(req.body.title);
    }

    try {
        const updatedProduct = await Product.findByIdAndUpdate(
            req.params.id,
            {
                $set: req.body
            },
            { new: true }
        );
        res.status(200).json(updatedProduct);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
}
)

//DELETE PRODUCT
router.delete('/:id', async (req, res) => {
    try {
        await Product.findByIdAndDelete(req.params.id);
        res.status(200).json('Product has been deleted...');
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

//GET PRODUCTS
router.get('/find/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        res.status(200).json(product);

    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});

//GET ALL PRODUCTS
router.get('/', async (req, res) => {
    const qNew = req.query.new;
    const qCategory = req.query.category;


    try {
        let products;
        if (qNew) {
            products = await Product.find().sort({ createdAt: -1 }).limit(15);
        } else if (qCategory) {
            products = await Product.find({
                categories: {
                    $in: [qCategory]
                }
            });
        } else {
            products = await Product.find();
        }

        res.status(200).json(products);
    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});


// ==========================================
// RUTA DE CLASIFICACIÓN FINAL (EMOJIS + PROMOS)
// GET /api/products/fix-categories-final
// ==========================================
/*
router.get('/fix-categories-final', async (req, res) => {
    try {
        const products = await Product.find();
        let log = [];
        let counters = {};

        // Normalizar texto (quitar acentos y minúsculas)
        const normalize = (str) => str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

        // REGLAS DE CLASIFICACIÓN
        // El orden importa: el script se detiene en la primera coincidencia que encuentre.
        const rules = [
            {
                category: 'Promociones 🎫',
                keywords: ['promo', 'cupon', 'cupón', 'paquete', 'kit']
            },
            {
                category: 'Pollo y aves 🍗',
                keywords: ['pollo', 'pechuga', 'pierna y muslo', 'alitas', 'nugget', 'boneless', 'tiras', 'pavo', 'muslo']
            },
            {
                category: 'Carne de Res 🥩',
                keywords: ['res', 'bistec', 'ribeye', 'rib eye', 'tbone', 't-bone', 'sirloin', 'arrachera', 'picaña', 'picanha', 'new york', 'aguja', 'hígado', 'higado', 'medallones', 'albondigon', 'carne molida', 'molida de res']
            },
            {
                category: 'Carne de Cerdo 🐷',
                keywords: ['cerdo', 'puerco', 'chuleta', 'milanesa', 'chamorro', 'maciza', 'pastor', 'carne enchilada', 'manita', 'lomo', 'costilla', 'baby back', 'chicharron', 'chicharrón', 'longaniza', 'chorizo', 'molida de cerdo']
            },
            {
                category: 'Pescados y mariscos 🐟',
                keywords: ['tilapia', 'camaron', 'camarón', 'surimi', 'mojarra', 'salmón', 'salmon', 'atun', 'atún', 'marlin', 'filete', 'sopa de mariscos', 'bacalao', 'basa']
            },
            {
                category: 'Salchichoneria 🥓',
                keywords: ['jamon', 'jamón', 'salchicha', 'tocino', 'queso puerco']
            },
            {
                category: 'Lacteos y huevo 🥚',
                keywords: ['huevo', 'leche', 'queso', 'crema', 'yogur', 'yoghurt', 'mantequilla', 'margarina', 'nata', 'cottage', 'alpura', 'lala', 'santa clara', 'nutrileche']
            },
            {
                category: 'Frutas 🍎',
                keywords: ['manzana', 'platano', 'plátano', 'uva', 'fresa', 'melon', 'melón', 'sandia', 'sandía', 'papaya', 'mango', 'piña', 'limon', 'limón', 'guayaba', 'naranja', 'mandarina', 'toronja', 'lima', 'pera', 'durazno', 'ciruela', 'kiwi', 'tejocote', 'caña', 'mamey', 'dominico']
            },
            {
                category: 'Verduras 🥕',
                keywords: ['jitomate', 'tomate', 'cebolla', 'ajo', 'papa', 'zanahoria', 'calabaza', 'chayote', 'lechuga', 'espinaca', 'acelga', 'cilantro', 'perejil', 'epazote', 'chile', 'pimiento', 'brocoli', 'brócoli', 'coliflor', 'pepino', 'nopal', 'ejote', 'chicharo', 'chícharo', 'elote', 'verdura', 'aguacate', 'apio', 'betabel', 'rabano', 'rábano', 'jicama', 'jícama', 'setas', 'champiñones', 'romeritos', 'esparragos', 'espárragos', 'hierbas']
            },
            {
                category: 'Abarrotes y semillas 🥫',
                keywords: ['arroz', 'frijol', 'lenteja', 'azucar', 'azúcar', 'sal', 'aceite', 'harina', 'pasta', 'sopa', 'espagueti', 'pure', 'puré', 'mayonesa', 'mostaza', 'catsup', 'vinagre', 'cereal', 'galletas', 'cafe', 'café', 'te', 'pan', 'tostadas', 'maiz', 'maíz', 'almendra', 'nuez', 'pasas', 'cacahuate', 'chia', 'chía', 'canela', 'salsa', 'ate', 'tamarindo', 'jamaica', 'mole', 'tortitas']
            }
        ];

        for (let product of products) {
            const nameNormal = normalize(product.title);
            let assignedCategory = 'Otros'; // Categoría por defecto si no encuentra nada

            // Buscar coincidencia
            for (let rule of rules) {
                // Verificamos si alguna palabra clave está en el título
                if (rule.keywords.some(k => nameNormal.includes(k))) {
                    assignedCategory = rule.category;
                    break; // Encontramos la categoría, dejamos de buscar
                }
            }

            // Regla especial: Si dice "costilla" pero no dice "cerdo" ni "res", asumimos res (o cerdo según tu inventario)
            // En tu lista vi "Costilla de res" y "Costilla de cerdo", así que el script de arriba ya lo cubre.

            // Guardar en Base de Datos
            await Product.updateOne(
                { _id: product._id },
                { $set: { categories: [assignedCategory] } }
            );

            // Log para ver el resultado
            if (!counters[assignedCategory]) counters[assignedCategory] = 0;
            counters[assignedCategory]++;
            log.push(`${product.title}  --->  ${assignedCategory}`);
        }

        res.json({
            success: true,
            total_processed: products.length,
            summary: counters,
            details: log
        });

    } catch (err) {
        console.error(err);
        res.status(500).json(err);
    }
});
*/

module.exports = router;