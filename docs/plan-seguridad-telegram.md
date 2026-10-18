# Auditoría de seguridad del backend — APARCADA, esperando fecha

> **Estado:** documentada el 12 oct 2026, **sin ejecutar**. El dueño decidió priorizar el
> proyecto de Telegram y le pondrá fecha a esto después. **No borrar este archivo.**
>
> Nada de lo descrito aquí se ha corregido todavía.

Auditoría de los 24 archivos de rutas. **De ~128 endpoints, ~90 no tienen ninguna
autenticación.** Verificado en vivo contra producción.

---

## 1. Fuga de la base de clientes (lo más grave)

```
$ curl https://backendfresh-production.up.railway.app/api/clientes/lite
HTTP 200 · 3,954,085 bytes · 8,170 clientes
```

`routes/clientes.js:803` devuelve, sin pedir credenciales:

| Campo | Cobertura |
|---|---|
| `nombre` | 8,170 |
| `telefono` + `telefonoSecundario` | 8,170 |
| `direccion` completa | 8,170 |
| **`gpsLink`** (ubicación exacta del domicilio) | **4,745** |
| `misDirecciones[]` | todas |

Son datos personales bajo la LFPDPPP. Cualquiera con la URL se descarga el padrón entero.

Mismo problema en menor grado, todos sin auth y verificados con HTTP 200:
`GET /clientes/filtered` (1.2 MB), `GET /clientes/` (:495), `GET /clientes/detalle/:telefono`
(:330), `GET /clientes/search` (:724), `GET /clientes/en-peligro` (:837),
`GET /clientes/audience` (:104), `GET /clientes/stats` (:937),
`GET /pedidos/cliente/:telefono` (:743), `GET /pedidos/` (:776), `GET /wallet/debug/audit` (:609).

## 2. Borrado y modificación sin autenticación

| Endpoint | Permite |
|---|---|
| `DELETE /api/clientes/:id` — `clientes.js:354` | borrar cualquier ficha |
| `DELETE /api/pedidos/:id` — `pedidos.js:679` | borrar cualquier pedido (revierte puntos) |
| `PUT /api/clientes/:id` · `/edit/:id` | editar cualquier ficha |
| `PUT /api/clientes/canjear/:telefono` — `:471` | poner puntos y racha a cero |
| `PUT /api/clientes/reset-puntos/:telefono` · `/reset-racha/:telefono` | igual |
| `PUT /api/pedidos/:id` — `:668` | modificar cualquier pedido |

`canjear/:telefono` usa `{ $regex: req.params.telefono }` **sin anclar** → acepta inyección de
regex. Con `findOneAndUpdate` el daño se limita a un documento, pero el patrón se repite.

## 3. Envíos masivos sin autenticación

`POST /api/marketing/email/send-bulk`, `POST /api/marketing/send`, `POST /api/wallet/notify-bulk`.

Cualquiera puede mandar un correo a toda la base **desde el dominio de Fresh Market**, o quemar
la cuota de notificaciones de Google Wallet. El más destructivo es `POST /api/marketing/send`:
sin `clientIds` hace broadcast a **todos** los `WalletDevice` (`marketing.js:57-60`).

## 4. Endpoints de IA sin autenticación (costo directo)

Los 6 POST de `routes/ai.js` llaman a Claude con `ANTHROPIC_API_KEY` sin credenciales:
`/parse-pedido` (:121), `/chat-pedido` (:357), `/prefill-pedido` (:534), `/chat-prefill` (:594),
`/consolidar-compras` (:716), `/mensaje-reactivacion` (:819).

Agravante: `index.js:11` tiene `express.json({ limit: '25mb' })` global y `/parse-pedido` acepta
capturas en base64 → imágenes de 25 MB en bucle, facturadas a la cuenta del dueño.

## 5. `WALLET_SECRET` no existe en Railway

Verificado: **la variable no está definida** en `production/backendFresh`. Por tanto
`routes/walletService.js:21` cae al fallback `'fresh-market-secret-key-2025'`, que está en el
código fuente.

Como `authenticationToken = HMAC-SHA256(clienteId, WALLET_SECRET)` y el `clienteId` aparece en
URLs públicas (`/wallet/download/apple/:clientId`), cualquiera que lea el repo puede calcular el
token de cualquier cliente y leer o dar de baja su pase. Afecta a 158 dispositivos.

### Rotación sin romper los pases instalados

El token va **grabado dentro del `.pkpass`** (`walletService.js:171` → campo
`authenticationToken`, :195). Cambiar el secreto de golpe hace que las tres rutas `/v1/*`
devuelvan 401: los pases dejan de actualizarse y las notificaciones mueren. (Google Wallet no se
ve afectado: usa la service account.)

1. `validateAuthToken` acepta `WALLET_SECRET` **y** `WALLET_SECRET_PREVIOUS`, con
   `crypto.timingSafeEqual`. La emisión (:171) usa siempre el nuevo.
2. En Railway: `WALLET_SECRET_PREVIOUS = fresh-market-secret-key-2025` y
   `WALLET_SECRET = <nuevo, 32+ bytes aleatorios>`.
3. Desplegar. Los pases viejos siguen validando.
4. `node scripts/notificarWallets.js`: cada iPhone re-descarga y recibe el token nuevo.
5. Vigilar 401 en `/api/wallet/v1/*`:
   `railway logs -p diligent-unity -e production -s backendFresh --http --since 7d`
6. Tras ~3-4 semanas sin 401, quitar `WALLET_SECRET_PREVIOUS` y hacer que el arranque falle si
   falta `WALLET_SECRET`.

## 6. El PIN de los clientes

614 de 8,171 clientes (7.5%) tienen PIN, guardado con
`CryptoJS.AES.encrypt(pin, PASS_SEC)` (`clientesAuth.js:93`). Formato OpenSSL con salt aleatorio
(verificado: 0 valores repetidos entre clientes). **Pero es cifrado reversible, no hash**: `:202`
y `:481` lo descifran y comparan en claro.

1. **Viaja en respuestas públicas.** `POST /clientes/buscar` hace `res.json(cliente)` con el
   documento entero (971 peticiones desde 182 IPs en 11 días — lo usa la tienda). Quien enumere
   teléfonos cosecha los 614 PINs cifrados.
2. **Es reversible.** Si `PASS_SEC` se filtra, todos quedan en claro retroactivamente.
3. 🚩 **Fallback `process.env.PASS_SEC || process.env.JWT_SEC`** (`:92, :201, :360, :480`). Hoy
   `PASS_SEC` existe, así que no aplica — pero si faltara, los PINs se cifrarían con la misma
   clave que firma los JWT de admin. Como el PIN tiene 4-8 dígitos, eso daría un oráculo offline
   para adivinar `JWT_SEC`. **Eliminar el fallback.**

**Arreglo inmediato:** `pin: { type: String, select: false }` en `models/Clientes.js:29`, más
`.select('+pin')` en `clientesAuth.js:202` y `:481`. Revisar `:69`, `:193`, `:472` (solo
comprueban existencia) y `clientes.js:140` (`tienePin: !!existente.pin`, que pasaría a dar
siempre `false`).

**De fondo:** migrar a bcrypt sin forzar resets — en el siguiente login válido se tiene el PIN
en claro un instante; ahí se re-guarda hasheado. Los 614 migran solos.

**Además:** `POST /clientes/buscar` debe devolver solo `{ existe, nombre, tieneCuenta }`.

## 7. Certificados de APNs commiteados

Los 5 archivos de `certs/` **están rastreados por git** (verificado con `git ls-files`):
`pass.cer`, `request.csr`, `signerCert.pem`, **`signerKey.pem`**, `wwdr.pem`.

`signerKey.pem` es la clave privada con la que se firman los pases de Wallet: quien la tenga
puede emitir pases que se hagan pasar por Fresh Market.

**No urgente**: el repo es privado y de un solo dueño. Propuesta: moverlos a variables de
entorno en base64 (junto con `GOOGLE_KEY_JSON`), añadir `certs/` al `.gitignore` y cargarlos
desde env con fallback al archivo. **Rotar el certificado solo si el repo deja de ser privado o
se comparte acceso.**

## 8. Otros

- **CORS abierto a `*`** (`index.js:10`): permite explotar todo lo anterior desde el navegador
  de cualquier visitante. Acotar al dominio del panel y de la tienda.
- `keys.json` (service account de Google Wallet) **sí está en `.gitignore` y nunca se commiteó**
  (verificado con `git ls-files` y `git log --all`). El historial está limpio: **no hace falta
  `git filter-repo` ni BFG**. Pero su clave privada quedó expuesta en la salida de un comando
  durante la sesión del 12 oct 2026 → **rotar la service account en Google Cloud** y actualizar
  `GOOGLE_KEY_JSON` en Railway en el mismo momento, o la emisión de pases Google se cae. De paso,
  eliminar el fallback a `keys.json` en `pushGoogle.js:19`.
- `routes/stripe.js` no está montado en `index.js`: código muerto con `STRIPE_KEY`. Eliminar.
- `.env` **no está en `.gitignore`** del panel (`~/Desktop/pedidosfresh/pedidos`) ni de la tienda
  (`~/dev/fresh-market-order`). No están rastreados aún, pero un `git add -A` los subiría.

---

## Lo que dicen los logs: sin evidencia de acceso no autorizado

Logs HTTP de Railway, **ventana disponible: 2 → 12 oct 2026 (11 días)**, 16,709 peticiones.
Antes del 1 de octubre no hay retención.

| | |
|---|---|
| Peticiones a endpoints con datos de clientes | 1,512 |
| …con User-Agent de herramienta, bot o vacío | **4 — las 4 fueron las pruebas de la auditoría** |
| Escrituras (`DELETE`/`PUT`) a clientes y pedidos | 215, **ninguna** con UA de herramienta |
| User-Agents vacíos en toda la ventana | 0 |

Todas las IPs que consultan `/clientes/lite` y `/clientes/filtered` son rangos residenciales y
móviles mexicanos (Telcel, Totalplay, Izzi) con Chrome Android, iPhone y Safari Mac: el patrón
del panel usado por el equipo desde sus teléfonos.

Googlebot y Bingbot rastrearon el dominio (`/robots.txt` → 404) pero solo llegaron a
`/api/app-config`, `/api/despensas` y `/api/products`. **No tocaron `/api/clientes/*`.**

> **Advertencia:** 11 días no prueban nada sobre los meses anteriores. El endpoint lleva abierto
> desde que existe. Puede afirmarse que en la ventana observable no hay rastro de scraping; no
> que nunca haya ocurrido.

---

# Plan de corrección

La infraestructura de autenticación **ya existe y funciona**, solo no se aplica:

- `POST /api/admin/login` (`routes/adminAuth.js`) emite un JWT `role: 'fresh-admin'` de 30 días
  contra `ADMIN_PASSWORD`.
- `requireAdmin` (`utils/adminMiddleware.js`) lo valida. Verificado: `GET /pedidos/rifa-ganadores`
  responde **401** correctamente.
- Solo 4 endpoints lo tienen puesto hoy: `clientes.js:239`, `pedidos.js:347, 365, 377`.

Modelo **deny-by-default**: middleware global en `index.js` que exige `requireAdmin` salvo
allowlist explícita, para que cualquier endpoint nuevo nazca protegido.

```js
// utils/allowlist.js
const PUBLICAS = [ /* la tabla de abajo */ ];
// index.js, después de los parsers y antes de las rutas:
app.use('/api', (req, res, next) =>
  esPublica(req.method, req.baseUrl + req.path) ? next() : requireAdmin(req, res, next));
```

## PÚBLICAS — 25 rutas (verificado con 11 días de tráfico real)

| Ruta | Quién la usa | Tráfico (11 d) |
|---|---|---|
| `POST /api/admin/login` | panel | **+ rate limit** |
| `GET /api/app-config` | tienda | 3,193 req · 658 IPs |
| `GET /api/products`, `/products/find/:id` | tienda | 2,030 req · 622 IPs |
| `GET /api/despensas`, `/despensas/find/:id` | tienda | 1,749 req · 621 IPs |
| `GET /api/promociones/activas` | tienda | 526 req · 102 IPs |
| `GET /api/colonias-envio`, `/colonias-envio/cp/:cp` | tienda (checkout) | 54 req · 26 IPs |
| `POST /api/clientes/buscar` | tienda | 971 req · 182 IPs · **⚠️ recortar respuesta** |
| `POST /api/clientes/new` | tienda | **+ rate limit** |
| `POST /api/clientes/guardar-email` | tienda | **+ rate limit** |
| `POST /api/clientes-auth/setup-pin` · `/login` · `/forgot-pin` · `/reset-pin` · `PUT /update-email` | tienda | **+ rate limit** |
| `POST /api/pedidos/new` | tienda + ManyChat | **+ rate limit** |
| `POST /api/pedidos/confirmacion` | tienda | **+ rate limit** |
| `POST /api/roulette/girar` · `/canjear` | tienda | 0 req en la ventana |
| `GET /api/wallet/download/apple/:clientId` · `/google/:clientId` · `/go/:clientId` | clientes | — |
| `POST`/`GET`/`DELETE` `/api/wallet/v1/*` (4 rutas) | **Apple PassKit** | tienen HMAC propio |

`/api/wallet/v1/*` NO lleva `requireAdmin`: los llama Apple. Su autenticación es
`validateAuthToken` (lo que arregla el punto 5).

## ADMIN — todo lo demás (~90 rutas)

- **`clientes.js`**: `GET /` `/lite` `/filtered` `/search` `/audience` `/stats` `/en-peligro`
  `/inactivos-semana` `/detalle/:telefono` `/find/:id` `/diagnostico` `/sync-wallets`
  `/debug-google`; `PUT /:id` `/edit/:id` `/add-address/:id` `/reset-puntos/:telefono`
  `/reset-racha/:telefono` `/canjear/:telefono`; `DELETE /:id`.
- **`pedidos.js`**: `GET /` `/semana` `/semanaPasada` `/buscar-fecha` `/find/:id`
  `/cliente/:telefono` `/stats/*` `/rifa-ranking`; `PUT /:id`; `DELETE /:id`.
- **`ai.js`**: las 6. Además límite de body de 5 MB en `/parse-pedido` y `/prefill-pedido`
  (reciben capturas), 1 MB en el resto. El `express.json` global baja a 1 MB.
- **`marketing.js` + `emailMarketing.js`**: las 7.
- **`walletService.js`**: `POST /notify-bulk`, `GET /test-push/:clientId`.
  **`GET /debug/audit` → eliminar**, no protegerlo.
- **`metricas.js`**: las 3.
- **`despensas.js`/`product.js`/`promociones.js`/`coloniasEnvio.js`**: `POST`/`PUT`/`DELETE`.
- **`appConfig.js`**: los 3 `PUT`. **`inventarioStock.js`**: ambas.
- **`vendedores.js`**: `POST`/`PUT` (el `GET` lo usa el panel: admin también).
- **`repartidores.js`**: `GET /`. **`clientesAuth.js`**: `POST /admin-reset-pin` (hoy público
  pese al nombre).

## Casos que NO se pueden cerrar a ciegas

| Caso | Problema | Propuesta |
|---|---|---|
| `GET /api/rutas/hoy` | 185 req desde **20 IPs** — lo usa la app de repartidores (proyecto Railway `repartidores-fresh`), no el panel. `requireAdmin` la rompería. | Dejar público y darle autenticación propia en una iteración aparte |
| `PATCH /api/rutas/:id/pedido/:pedidoId`, `POST /:id/cerrar` | mismo origen probable (0 tráfico en la ventana) | verificar con el dueño quién los llama |
| `GET /api/product/fix-categories-final` | endpoint de mantenimiento que reescribe categorías, público | admin o eliminar |
| `routes/stripe.js` | no montado: código muerto | eliminar |
| `routes/auth.js`, `users`, `cart`, `order` | del e-commerce viejo; `User` tiene 2 documentos | verificar uso; si no, eliminar |
| `POST /api/clientes/buscar` | devuelve la ficha completa | recortar **antes** de desplegar |

## Orden de ejecución sugerido

1. **Login real en el panel** (bloqueante: sin esto, proteger endpoints deja al equipo fuera).
   `src/pages/Login.jsx` es hoy un stub de 9 líneas.
2. **Recortar `POST /clientes/buscar`** y `pin: select:false`.
3. **Deny-by-default + allowlist**, probado en staging.
4. **Rate limit** (`express-rate-limit`) en los públicos de escritura.
5. **`scripts/auditarRutas.js`**: recorre las ~128 rutas sin token y confirma 401 en privadas y
   200 en públicas. Contra staging y luego producción; queda como red de seguridad permanente.
6. **Secretos**: `WALLET_SECRET` (rotación del punto 5), service account de Google, certs de
   APNs, CORS, eliminar `stripe.js`.

**Riesgo:** medio. Aplicar `requireAdmin` a un endpoint que la tienda sí usa la rompe en
producción. Mitigación: la allowlist verificada contra tráfico real, el login desplegado primero,
y el checklist de staging que el proyecto de Telegram ya habrá montado.
