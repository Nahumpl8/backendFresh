# Sellos y premios — mecánica acordada

> Decidido el 13 oct 2026. **Todavía no implementado.**
> Documenta la diferencia entre lo que el sistema hace hoy y lo que debe hacer.

## La regla del negocio

- **1 sello por semana**, no por pedido. Da igual cuántas veces compres en la misma semana.
- Las semanas **no tienen que ser seguidas**.
- Al juntar **8 sellos**, en el **siguiente pedido** (el noveno) el cliente puede canjear
  **1 producto de hasta $80**.
- El premio **caduca a los 30 días**.
- **No hace falta tener la tarjeta de Wallet descargada** para acumular. La Wallet es una forma
  de ver los sellos, no el requisito para ganarlos.
- A partir del **1 de enero de 2027**, los sellos se reinician cada semestre (1 de enero y
  1 de julio). El periodo actual se deja correr: **el primer corte real es el 1 de enero de 2027.**

## Lo que el sistema hace hoy

`routes/pedidos.js:549-593`, campos en `models/Clientes.js:69-73`.

| Campo | Qué es | Estado |
|---|---|---|
| `sellos` | tarjeta actual 0-8, sube 1 por semana distinta (`ultimaSemanaSello`) | ✅ correcto |
| `sellosSemestrales` | acumulador **histórico total**, nunca se reinicia (hay clientes con 41) | ⚠️ el nombre engaña |
| `tarjetasCompletadas` | cuántas veces llegó a 8 | ✅ 207 clientes lo han hecho |
| `premioDisponible` | **booleano** | ⚠️ sin qué premio, cuándo, ni si se entregó |

Coincide con la regla en lo esencial (1 sello/semana, no hace falta continuidad) y **no exige
Wallet**, que es lo acordado.

### Lo que falta

1. **No hay semestre.** Nada en el código marca el inicio de un periodo ni reinicia nada.
   `sellosSemestrales` es histórico desde siempre: si el semestre hubiera empezado el 1 de julio
   (semana 27) y hoy fuera la 42, el máximo posible serían 15 — y hay clientes con 41.
2. **El premio es un booleano sin trazabilidad.** No se sabe qué se ofreció, cuándo se ganó ni
   si se entregó.
3. **El canje es implícito y silencioso:**
   ```js
   if (sellos >= 8) { sellos = 1; premioDisponibleWallet = false; tarjetasCompletadas += 1; }
   ```
   El premio se apaga en la siguiente compra **se haya entregado o no**. Si el cliente no sabe
   que ganó, lo pierde sin rastro.
4. **Nadie avisa.** Hoy el cliente se entera solo si abre la Wallet — y 32 de los 49 que tienen
   premio ni siquiera la tienen descargada.

## Estado actual de los datos (13 oct 2026)

| | |
|---|---|
| Clientes con al menos una tarjeta completada | 207 (137×1, 38×2, 24×3, 8×4) |
| **Con `premioDisponible: true` ahora** | **49** |
| …de esos, compraron en los últimos 30 días | 28 |
| …con Wallet descargada | 17 de 49 |
| Con sellos a medias (1-7) | 1,308 |
| Con sellos pero sin Wallet | 1,164 |

Los 49 llevan esperando entre 1 y 190 días. Trece completaron la tarjeta la semana pasada.

> Dato que parecía un bug y no lo es: 31 de los 49 tienen menos de 8 sellos.
> `scripts/resetPuntosYSellosActuales.js` pone los sellos a cero **conservando `premioDisponible`
> a propósito** (lo dice en su propio log). El sistema ya respeta el premio ganado aunque se
> reinicie la tarjeta.

## Lo que hay que construir

### A. Arreglar `premiosPendientes` (bloqueante)

Ver `docs/bug-premiospendientes.md`. Hoy el array es `[String]` por un `type: String` mal
anidado, y los premios se guardan serializados a JSON. Hay que corregir el esquema y migrar los
176 residuos con un backfill en dry-run.

Riesgo bajo: **la ruleta está muerta** (último giro: 24 dic 2025, hace 10 meses) y de esos 176
premios, 112 están caducados y 46 canjeados. Nadie depende de la forma actual.

### B. Emitir el premio como entrada, no como booleano

Al llegar a 8 sellos, además de `premioDisponible = true`, crear:

```js
{
  source: 'sellos',
  key: 'tarjeta-8',
  label: '1 producto de hasta $80',
  type: 'producto',
  value: 80,
  ganadoAt: new Date(),
  expiresAt: +30 días,
  redeemed: false,
  redeemedAt: null,
  tarjetaNumero: tarjetasCompletadas + 1   // evita duplicar si se recalcula
}
```

`premioDisponible` se mantiene por compatibilidad: lo leen la Wallet y el panel.

### C. Canje explícito

Hoy se apaga solo en la siguiente compra. Debe marcarse `redeemed: true` + `redeemedAt` cuando
el operador lo entrega, desde el panel. Si la tarjeta se reinicia con un premio sin canjear, el
premio **sigue vigente** hasta su `expiresAt` — que es lo que el sistema ya hacía de facto.

### D. Migrar los 49 actuales

- **28 vigentes** (completaron hace ≤30 días): `expiresAt` contado desde su semana real.
- **21 vencidos** (43 a 190 días): **plazo de gracia de 30 días desde que se les avisa**, no
  desde que lo ganaron. Ganaron bajo otra regla y no se les quita nada sin avisar.

### E. Reinicio semestral — a partir del 1 de enero de 2027

No es urgente: faltan ~2.5 meses. Hace falta:

- Un campo `semestreActual` (ej. `'2027-S1'`) en el cliente, o derivarlo de la fecha.
- Al dar un sello, si el semestre cambió: `sellos = 0` antes de sumar.
- Decidir **antes de diciembre** qué pasa con los 1,308 que tendrán sellos a medias en el corte,
  y avisarles con tiempo. Un corte sorpresa el 1 de enero es la forma más rápida de enfadar a
  los clientes más fieles.
- Renombrar o reinterpretar `sellosSemestrales`, cuyo nombre ya no corresponde a lo que guarda.

### F. Avisos por Telegram

Una vez exista la cola (Paso 3 del plan de Telegram):

- Al completar la tarjeta: "Ya tienes tu premio: 1 producto de hasta $80. Pídelo en tu próximo
  pedido. Vence el <fecha>."
- Recordatorio a ~7 días de caducar.
- Los 49 actuales entran por esta vía en cuanto haya suscriptores.

### G. Regalo por vincularse a Telegram

Sacado del Paso 1 de Telegram el 14 oct 2026: va en este deploy de premios, ya con
`premiosPendientes` arreglado, para no escribir más datos en la forma rota.
**Pendiente del dueño: definir qué producto es.** Será una entrada `source: 'telegram'`
con su `expiresAt`, una sola vez por cliente.

## Orden sugerido

1. **A** (arreglar el campo) — bloquea todo lo demás, y el regalo por vincularse a Telegram usa
   el mismo campo.
2. **B + C + D** — juntos: emitir, canjear y migrar los 49.
3. **F** — cuando Telegram tenga cola.
4. **E** — antes de diciembre, con aviso previo a los clientes.

**B y C tocan `routes/pedidos.js`**, que es el flujo de pedidos en producción. Hay que probarlo
en staging con los clientes ficticios (`5550000002` tiene la tarjeta completa) antes de tocar
producción.
