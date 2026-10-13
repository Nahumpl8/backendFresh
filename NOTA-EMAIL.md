# Nota: el índice de `email` en Clientes

**Esto no se tocó en el trabajo de métricas, a propósito.** Queda documentado
porque es una trampa para el próximo backfill que roce el campo.

## Qué pasa hoy

`models/Clientes.js` declara el campo y el índice por separado:

```js
email: { type: String, default: null, lowercase: true, trim: true, sparse: true }
ClienteSchema.index({ email: 1 }, { unique: true, sparse: true });
```

Pero en producción el índice realmente creado es:

```
email_1   { "email": 1 }   sparse      <- SIN unique
```

Es decir: el esquema pide `unique`, la base no lo tiene. Mongoose no recrea un
índice que ya existe con otras opciones, así que la diferencia se ha quedado ahí.

Estado de los datos: de 8,131 fichas, **545 tienen correo** y el resto **no tiene
el campo** (no es que valga `null`: la clave no existe en el documento).

## Por qué importa

Un índice `sparse` solo ignora los documentos donde **la clave no existe**. Un
`null` explícito **sí se indexa**. Entonces, si un script escribiera
`email: null` en las ~7,586 fichas sin correo:

- Con el índice actual (sin unique): pasa, pero deja 7,586 nulls indexados sin
  ganar nada.
- Si alguien alinea el índice con el esquema **después** de eso: la creación del
  índice unique **falla** por 7,586 duplicados, y habría que limpiar a mano.
- Peor: si Mongoose llega a crear el índice unique con los nulls ya escritos,
  cualquier alta de cliente sin correo empieza a fallar con E11000.

Por eso `scripts/backfillMetricas.js` **no toca `email`** bajo ninguna fase.

## Cómo alinearlo, si se quiere hacer

El orden importa. Primero limpiar, luego indexar:

```js
// 1) quitar los null explícitos que pudiera haber (deja la clave inexistente)
db.clientes.updateMany({ email: null }, { $unset: { email: "" } })

// 2) comprobar que no quedan correos repetidos
db.clientes.aggregate([
  { $match: { email: { $exists: true, $ne: null } } },
  { $group: { _id: "$email", n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } }
])

// 3) recrear el índice con unique
db.clientes.dropIndex("email_1")
db.clientes.createIndex({ email: 1 }, { unique: true, sparse: true, name: "email_1" })
```

Y de paso, en `models/Clientes.js`, quitar el `sparse: true` del campo o la
llamada a `.index()`: tener los dos es lo que provoca el aviso
`Duplicate schema index on {"email":1}` al arrancar (lo mismo pasa con
`telefono`, que tiene `unique: true` en el campo y un `.index()` aparte).

Mientras tanto nada está roto: el índice sin unique funciona para las búsquedas,
que es para lo que se usa.
