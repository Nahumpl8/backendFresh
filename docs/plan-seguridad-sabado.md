# Seguridad — plan para el sábado 17 oct 2026

Basado en un inventario verificado contra el código de los 3 frontends (tienda, panel y app de
repartidores en `~/Desktop/gestion-repartidores`). Corrige la clasificación de
`plan-seguridad-telegram.md`, que salió solo de logs y cerraba rutas que la tienda sí usa.

**Hoy:** ~130 rutas, 19 con `requireAdmin`. El panel no tiene login, los repartidores no tienen
login, y la tienda guarda el token del cliente pero nunca lo manda.

---

## Decisiones de diseño

### 1. Usuarios del panel (admins)
- Modelo nuevo `Admin`: `usuario`, `nombre`, `hash` (scrypt de Node, sin dependencias nuevas),
  `activo`, `ultimoAcceso`.
- `POST /api/admin/login { usuario, password }` → JWT `{ role:'fresh-admin', sub, usuario }`,
  7 días. Límite de 5 intentos fallidos por IP cada 15 min.
- Admins iniciales: **Armando, Nahum, Shade, Fernando** (cuenta con `nombre` y `usuario`, p. ej.
  `armando`).
- **Contraseña temporal = su celular** (decisión del dueño). Como un celular se puede adivinar
  (el de Shade es el WhatsApp público del negocio), la temporal:
  - solo sirve para UNA cosa: la pantalla de primer acceso. El token que da no abre nada más;
  - ahí pide **correo** (para recuperar la contraseña después) y **contraseña nueva** (mín. 8);
  - caduca a las 24 h de crear la cuenta: las cuentas se crean el mismo sábado, justo antes de
    que cada quien entre.
- Después, cada quien puede cambiar su contraseña desde el panel, y si la olvida, recibe un
  código por correo (mismo mecanismo que `forgot-pin` de los clientes).
- `scripts/crearAdmin.js` para dar de alta (nombre, usuario, celular; la temporal se deriva del
  celular y nunca se imprime ni queda en logs). Dar de baja = `activo:false` y su token deja de valer al instante
  (el middleware revisa que siga activo).
- La contraseña compartida `ADMIN_PASSWORD` sigue funcionando **solo durante la transición**
  y se apaga al final del día.
- Los PUT/DELETE de pedidos y clientes guardan `editadoPor` en el log: se sabe quién hizo qué.

### 2. Panel
- Pantalla de login real (`Login.jsx` hoy es un stub), token en `localStorage`.
- **Un interceptor global de axios** añade `Authorization` a toda llamada al backend: no hay que
  tocar los ~40 archivos con la URL escrita a mano. Ante 401 → vuelve al login.
- El mismo interceptor reescribe la URL de producción por `VITE_API_BASE` si existe: así se prueba
  el panel contra el backend local, con banner **STAGING** visible.
- Arreglos de paso: `test-push` se abre con `window.open` (no puede mandar token) → pasa a axios;
  se quita la llamada a `/api/roulette/claim` (no existe, 404; la ruleta se retira).

### 3. Repartidores
- `Repartidor` gana `pinHash` (PIN de 4 dígitos, scrypt). Lo asigna el admin desde la sección
  `/admin` de la app de repartidores (ya tiene login de admin).
- `POST /api/repartidores/login { id, pin }` → JWT `{ role:'repartidor', id, telefono }`, 7 días.
  Límite de intentos por IP y por repartidor.
- `GET /api/rutas/hoy` usa el teléfono **del token**, no el de la URL: un repartidor solo ve su ruta.
  `PATCH /rutas/:id/pedido/:pid` y `POST /rutas/:id/cerrar` verifican que la ruta sea suya.
- **Decisión del dueño (16 oct):** los repartidores SÍ pueden ver la dirección de cualquier
  cliente. `GET /api/clientes/lite` y `GET /api/clientes/find/:id` quedan para admin **o**
  repartidor con sesión (token de repartidor). Lo que se cierra es el acceso anónimo.
- `GET /api/repartidores` (lista para elegir nombre) sigue pública pero solo con `_id` y `nombre`
  (hoy expone teléfonos).

### 4. Deny-by-default
Middleware global en `index.js`: toda ruta `/api/*` exige admin **salvo** la allowlist de abajo.
Cualquier endpoint nuevo nace protegido.

### 5. Despliegue sin riesgo de dejar a nadie fuera: modo observación
1. Backend con todo lo anterior y `AUTH_MODO=observar`: **no bloquea nada**, solo registra en logs
   `🔒 [observar] bloquearía GET /api/… (sin token)`.
2. Se despliegan el panel (con login) y la app de repartidores (con PIN). El equipo entra.
3. Se miran los logs unas horas: cada línea `[observar]` es algo que se rompería. Se corrige.
4. `AUTH_MODO=bloquear` (cambio de variable en Railway, sin deploy de código).
   **Rollback = volver a `observar`**, inmediato.

---

## Clasificación de rutas

### Públicas (allowlist)

| Ruta | Quién | Nota |
|---|---|---|
| GET `/products`, `/despensas`, `/app-config`, `/promociones/activas`, `/colonias-envio/cp/:cp` | tienda | catálogo |
| GET `/pedidos/rifa-ranking` | tienda | solo primer nombre + 3 dígitos |
| POST `/clientes/buscar` | tienda, panel | **recortar respuesta** (hoy devuelve la ficha con PIN cifrado) |
| POST `/clientes/new`, `/clientes/guardar-email` | tienda | + límite de intentos |
| POST `/clientes-auth/setup-pin`, `/login`, `/forgot-pin`, `/reset-pin` | tienda | + límite de intentos |
| POST `/pedidos/new`, `/pedidos/confirmacion` | tienda, panel, internas (ManyChat NO crea pedidos: confirmado por el dueño) | + límite de intentos |
| GET `/clientes/detalle/:telefono`, PUT `/clientes/edit/:id`, PUT `/clientes/add-address/:id`, GET `/pedidos/cliente/:telefono` | tienda (perfil, checkout) | **Fase 2** (ver abajo); el sábado solo se recortan |
| GET `/wallet/download/apple/:id`, `/wallet/google/:id`, `/wallet/go/:id` | tienda, panel, emails | |
| `/wallet/v1/*` (4) | Apple | HMAC propio |
| POST `/telegram/webhook/:secret` | Telegram | secreto propio |
| POST `/admin/login`, `/repartidores/login` | login | + límite de intentos |
| GET `/repartidores` | app repartidores | solo `_id` y `nombre` |
| GET `/rutas/hoy`, PATCH `/rutas/:id/pedido/:pid`, POST `/rutas/:id/cerrar`, GET `/clientes/lite`, GET `/clientes/find/:id` | app repartidores | **token de repartidor o de admin** |

### Admin (todo lo demás)
- **clientes:** GET `/`, `/audience`, `/search`, `/en-peligro`, `/filtered`, `/stats`; DELETE `/:id`; POST `/clientes-auth/admin-reset-pin` (hoy cualquiera borra el PIN de cualquiera).
- **pedidos:** GET `/`, `/semana`, `/semanaPasada`, `/buscar-fecha`, `/find/:id`, `/stats/*`; PUT/DELETE `/:id`.
- **catálogo y config:** POST/PUT de products, despensas, promociones, colonias-envio; GET `/find/:id`; los 3 PUT de app-config; inventario-stock; vendedores; GET `/promociones` y `/colonias-envio` completos.
- **marketing:** las 7 (Wallet push masivo, email masivo).
- **wallet:** `/notify-bulk`, `/test-push/:id`.
- **IA:** las 6 (hoy cualquiera gasta en la cuenta de Anthropic y `chat-pedido` puede crear pedidos).
- **métricas:** las 3.


### Eliminar (nadie las llama)
- clientes: PUT `/:id` ($set libre), `/reset-puntos/:tel`, `/reset-racha/:tel`, `/canjear/:tel`, GET `/diagnostico`, `/sync-wallets`, `/debug-google`, `/inactivos-semana`.
- pedidos: GET `/stats/rango`, `/stats/promotores` → admin (por si se usan después).
- wallet: GET `/debug/audit`.
- roulette: `/girar`, `/canjear` (se retira la ruleta).
- e-commerce viejo: `/api/auth`, `/users`, `/carts`, `/orders` y `routes/stripe.js`.
- DELETE de products y despensas → admin (no eliminar: se pueden necesitar).

---

## Recortes de respuesta (el sábado)
- `pin`, `pinResetCode`, hashes de Telegram: `select:false` en el modelo → no salen en ninguna ruta.
- `POST /clientes/buscar`: solo lo que la tienda usa (se verifica campo por campo en `useAuth.jsx`, `CheckoutPage.jsx`, `WalletSection.jsx` antes de recortar).
- `PUT /clientes/edit/:id`: lista blanca de campos (nombre, email, dirección…). Hoy acepta `$set` libre: cualquiera con el `_id` se pone puntos o cambia el PIN.

## Fase 2 (otro día): rutas del cliente con su token
La tienda ya guarda el JWT del cliente (`freshmarket_token`) pero no lo manda. Fase 2: la tienda
lo manda y el backend exige que el `_id`/teléfono de la ruta sea el del token en `detalle`,
`edit`, `add-address`, `pedidos/cliente`. Requiere deploy coordinado tienda + backend y manejar a
quien tenga sesión vieja. **Riesgo conocido que queda:** `setup-pin` deja poner PIN a un cliente
que aún no tiene, solo con su teléfono (614 tienen PIN de ~8,200). Solución real: verificar por
Telegram o por correo; se diseña aparte.

## Bugs encontrados de paso
1. `pedidos.js:619` devuelve el link `/api/wallet/apple/:id`, que no existe (es `/download/apple/:id`).
2. `emailService.js:62` arma `/api/wallet/download/google/:id`, que no existe (es `/google/:id`):
   el botón de Google Wallet del correo de bienvenida está roto.
3. El panel llama a `/api/roulette/claim` → 404.

## Secretos (al final del día o aparte)
- `WALLET_SECRET` no existe en Railway → se usa el valor fijo del código. Rotarlo sin romper los
  158 pases instalados requiere aceptar el secreto viejo y el nuevo un tiempo (plan en
  `plan-seguridad-telegram.md` §5). **Aparte**, no el sábado.
- Rotar la llave de la service account de Google Wallet (salió en un output el 14 oct).
- CORS: limitar a freshmarket.mx, el dominio del panel y el de repartidores.

---

## Orden del sábado

| # | Qué | Dónde | Riesgo |
|---|---|---|---|
| 1 | Rama `seguridad` desde `main` (sin nada de Telegram) | backend | — |
| 2 | Modelo Admin + login + script; PIN de repartidores + login; middleware deny-by-default en modo observar; recortes; eliminar rutas muertas; bugs | backend | bajo (observar no bloquea) |
| 3 | Login + interceptor + banner STAGING | panel | bajo |
| 4 | PIN en login de repartidor, token en llamadas, alta de PIN en `/admin`. Antes: `git init` local (hoy no tiene historial) | app repartidores (`~/Desktop/gestion-repartidores`, se despliega con `railway up`, proyecto `repartidores-fresh`, https://repartidores-fresh-production.up.railway.app) | medio |
| 5 | Pruebas en local: los 3 frontends contra el backend local; `scripts/auditarRutas.js` (cada ruta sin token: 401 o 200 según la tabla) | local | — |
| 6 | Deploy backend (observar) → crear admins → deploy panel → deploy repartidores | prod | bajo |
| 7 | Revisar logs `[observar]`, corregir | prod | — |
| 8 | `AUTH_MODO=bloquear`; correr `auditarRutas.js` contra prod; apagar `ADMIN_PASSWORD` | prod | medio, rollback inmediato |

Estimado: el día completo. Los pasos 6-8 conviene hacerlos de tarde/noche, cuando la tienda tiene
menos tráfico (los pedidos de la semana ya cerraron el viernes 7 pm).
