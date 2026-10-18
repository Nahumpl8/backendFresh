# Checklist de pruebas — Telegram

Todo se valida en **staging** antes de tocar producción.
Nada pasa a producción hasta el Paso 6, y solo con OK explícito del dueño.

- **Backend staging:** https://backendfresh-staging.up.railway.app
- **Base:** `freshapi_staging` (Atlas, separada de producción)
- **Bot de pruebas:** @FreshMarketPruebabot
- **Clientes ficticios:** `5550000001` … `5550000005`

| Teléfono | Cliente | Para probar |
|---|---|---|
| 5550000001 | Ana Prueba - Centro | cliente activo, 150 puntos, 4 sellos, 2 pedidos |
| 5550000002 | Beto Prueba - Lindavista | tarjeta de sellos completa (8), premio disponible |
| 5550000003 | Carla Prueba - Real del Monte | **premio de ruleta que caduca en 2 días** |
| 5550000004 | Diego Prueba - Sin compras | ficha sin pedidos |
| 5550000005 | Elena Prueba - Dormida | sin comprar hace 75 días, segmento `dormido` |

Recrear los datos: `APPLY=1 LIMPIAR=1 node scripts/seedStaging.js` (con `MONGO_URL` de staging).

---

## Paso 0 — Staging seguro

- [x] Base `freshapi_staging` separada de producción
- [x] Environment `staging` en Railway, creado **con las variables ya sobrescritas** (nunca
      llegó a existir con credenciales de producción)
- [x] `ANTHROPIC_API_KEY`, `EMAIL_*` y `GOOGLE_KEY_JSON` vacías en staging
- [x] `JWT_SEC`, `PASS_SEC` y `ADMIN_PASSWORD` propios (un token de staging no vale en producción)
- [x] Guarda de email: `jsonTransport`, verificado en el servidor
- [x] Guarda de Anthropic: 503 sin llamar a la API, verificado en el servidor
- [x] Guarda de push Apple: no instancia el provider, verificado en el servidor
- [x] Guarda de Google Wallet: early-return, verificado en local
- [x] Control: con `APP_ENTORNO` ausente (producción) nada cambia
- [x] Seed rechaza una `MONGO_URL` que no sea de staging (probado contra la de producción)
- [x] Seed idempotente: la segunda corrida no duplica
- [x] Aislamiento: staging 5 clientes / producción 8,172 intactos
- [ ] `TELEGRAM_BOT_TOKEN` movido de `production` a `staging` ← **pendiente del dueño**
- [ ] Usuario propio de Atlas para `freshapi_staging` ← **pendiente del dueño**
- [ ] Decidir cómo evita staging quedar sobrescrito por un push a `main` ← **pendiente**

## Paso 1 — Bot vivo

- [x] Webhook: ruta falsa 404, sin cabecera 401, secreto falso 401, correcto 200
- [x] Webhook: cuerpo de más de 64 KB rechazado (413)
- [x] Endpoints de admin dan 401 sin token (estado, suscriptores, beta, modo, prueba)
- [x] Con TELEGRAM_ENABLED=false no se monta ninguna ruta ni se carga el módulo
- [ ] `getWebhookInfo` sin `last_error_message` y con `pending_update_count` en 0
- [ ] Vinculación por deep link
- [x] Vinculación compartiendo teléfono (14 oct, con el teléfono del dueño)
- [x] Teléfono escrito a mano se rechaza y explica por qué
- [x] Chat sin ficha queda registrado con su teléfono
- [x] Consultas del menú: sellos, puntos y último pedido
- [ ] Vinculación por `/vincular` con código
- [ ] **Reenviar el contacto de otra persona NO vincula** (`contact.user_id !== from.id`)
- [ ] Token caducado ofrece el teclado de contacto, no un error seco
- [ ] Chat ya vinculado: idempotente
- [x] `Clientes.telegramId` y `TelegramChat.clienteId` quedan consistentes
- [x] Índice parcial único sobre `telegramId` creado con scripts/crearIndiceTelegram.js
- [ ] Modo beta: quien no está en la lista recibe "¡Muy pronto! 🥬" y queda en `TelegramChat`
- [ ] Modo beta: el servidor rechaza campañas con audiencia fuera de la lista

## Paso 2 — Login del panel

- [ ] Login contra `/api/admin/login` con la contraseña de staging
- [ ] Token guardado; el header viaja en las llamadas de la página Telegram
- [ ] Un 401 redirige a login
- [ ] **Las demás páginas del panel siguen funcionando igual que hoy**
- [ ] `VITE_API_BASE` apunta a staging
- [ ] **Banner "STAGING" visible** en todas las páginas cuando no apunta a producción

## Paso 3 — Menú, cola y handoff

- [ ] `/mispuntos`, `/missellos`, `/mipedido`, `/ayuda`, `/baja` responden con datos correctos
- [ ] `/baja` apaga campañas pero no los transaccionales
- [ ] Cola: `railway redeploy` a media cola se drena sin duplicados
- [ ] `403 bot was blocked` deja `status: 'bloqueado'` **sin reintentos**
- [ ] Desbloquear el bot y volver a escribir se recupera
- [ ] `429` respeta `retry_after`
- [ ] Nombres con `.`, `-` o `(` no rompen el mensaje (HTML escapado)
- [ ] Handoff: mensaje libre llega al grupo con nombre, teléfono, segmento y último pedido
- [ ] Reply del equipo llega al cliente
- [ ] Fotos en ambos sentidos
- [ ] Mensaje del grupo que **no** es reply se ignora
- [ ] Auto-respuesta máximo 1 vez cada 30 min por chat
- [ ] Todo queda en `TelegramMessage` como `handoff_in` / `handoff_out`

## Paso 4 — Campañas

- [ ] Envío de prueba al chat propio
- [ ] Placeholders `{{nombre}}`, `{{puntos}}`, `{{sellos}}` se sustituyen
- [ ] Progreso en vivo
- [ ] Cancelación deja los pendientes en `cancelado`
- [ ] **Tope de 2 campañas/semana por suscriptor, aplicado en el servidor** (no solo en la UI)
- [ ] Los links llevan `utm_source=telegram`

## Paso 5 — Mini App

- [ ] Abre la tienda de staging dentro de Telegram
- [ ] Pedido completo de punta a punta
- [ ] El pedido llega con `fuente: 'telegram'`
- [ ] Aparece en `/api/metricas/semanal` dentro de `porFuente`

## Paso 6 — Producción (requiere OK)

- [ ] Bot real creado y variables en `production`
- [ ] Webhook apuntando a producción, verificado con `getWebhookInfo`
- [ ] `TELEGRAM_MODO=beta` con 10–20 clientes
- [ ] Rollback probado: `TELEGRAM_ENABLED=false` + `deleteWebhook` deja el sistema como estaba
- [ ] Primer mensaje de bienvenida a los que quedaron en espera, **una sola vez**
