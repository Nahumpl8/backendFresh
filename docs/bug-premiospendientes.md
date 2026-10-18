# Bug: `premiosPendientes` se guarda como texto, no como subdocumentos

> Detectado el 13 oct 2026 montando el entorno de staging. **No corregido.**
> Afecta a producción y a 113 clientes.

## Qué pasa

`models/Clientes.js:107-115` declara:

```js
premiosPendientes: [{
    label: String,
    type: String,        // ← el problema
    value: Number,
    expiresAt: Date,
    redeemed: { type: Boolean, default: false },
    redeemedAt: Date,
    spinId: { type: String }
}],
```

Mongoose reserva la clave `type` para declarar el tipo. Al encontrar `type: String` dentro del
objeto, no entiende "un campo llamado type que es String": entiende **"este array es de
Strings"**. El resto de claves se descartan.

Resultado: `premiosPendientes` es un `[String]`, y cada premio se guarda **serializado a JSON**.

Comprobado en producción (113 clientes con premios pendientes):

```json
"{\"source\":\"roulette\",\"key\":\"10off\",\"label\":\"$10 de descuento\",
  \"type\":\"discount\",\"value\":10,\"expiresAt\":\"2025-10-09T02:36:46.573Z\",
  \"redeemed\":false,\"spinId\":\"68bf92be45271c457c628c95\"}"
```

El elemento es de tipo `string`, no un objeto.

## Qué se rompe

`routes/roulette.js:121-130` canjea el premio así:

```js
{ "premiosPendientes.spinId": spinId }        // filtro
{ "premiosPendientes.$.redeemed": true }      // actualización
```

Esa consulta busca un campo `spinId` **dentro de objetos** del array. Como los elementos son
cadenas de texto, **nunca puede hacer match**. El canje por esa vía no funciona.

Tampoco se puede consultar por `expiresAt` desde Mongo: `{ 'premiosPendientes.expiresAt': { $lt: ... } }`
no encuentra nada. Para saber qué premios caducan hay que traer los clientes y parsear el JSON
en Node.

## Impacto en el proyecto de Telegram

El **Paso 1 guarda el regalo por vincularse en `premiosPendientes`**. Hereda el problema:

- Si se escribe como subdocumento, Mongoose lo rechaza con `CastError` (es lo que pasó al
  sembrar staging).
- Si se escribe como string JSON, funciona e iguala lo que ya hay, pero el aviso de "premio por
  caducar" tendrá que parsear en memoria en vez de filtrar en la consulta.

Mientras no se arregle, **todo lo nuevo debe usar la forma string**, que es la que existe de
verdad. `scripts/seedStaging.js` lo hace así a propósito, con el comentario correspondiente.

## Cómo arreglarlo (cuando se decida)

La declaración correcta para un campo llamado `type` es anidarlo:

```js
premiosPendientes: [{
    source:   { type: String },
    key:      { type: String },
    label:    { type: String },
    type:     { type: String },   // ← así sí es un campo llamado "type"
    value:    { type: Number },
    expiresAt:{ type: Date },
    redeemed: { type: Boolean, default: false },
    redeemedAt: { type: Date },
    spinId:   { type: String },
}],
```

Pero cambiar el esquema **sin migrar los datos rompe la lectura** de los 113 clientes: Mongoose
intentaría castear cadenas a subdocumentos. Hace falta un backfill que recorra esos clientes,
haga `JSON.parse` de cada elemento y reescriba el array como objetos. En dry-run primero, como
los demás scripts del repo.

Orden sugerido: backfill → cambio de esquema → desplegar juntos. Y revisar `routes/roulette.js`
y cualquier sitio que lea el array, porque hoy están escritos contra la forma string.

## Alcance

- 113 clientes con premios pendientes en producción.
- Nadie ha reportado el fallo del canje, probablemente porque los premios se entregan a mano
  por WhatsApp y el `redeemed` se gestiona en otro sitio o no se gestiona.
