# AGENTS.md: integrar un sistema externo con pedidos de Morsis

Instrucciones para un asistente de IA (LLM) al que le piden implementar, en **otro sistema**
(cualquier lenguaje), la misma integración que muestra este repositorio: cobrar en una caja externa
un pedido de Morsis identificado por su cupón de pago. La versión para personas es
[`docs/GUIA-INTEGRACION.md`](docs/GUIA-INTEGRACION.md). Si algo de este archivo choca con la
especificación oficial, gana la especificación.

## Fuentes de verdad (leelas antes de escribir código)

1. Especificación OpenAPI: `https://api.morsis.com/v1/openapi.yaml` (la API agrega campos; no
   inventes endpoints ni campos que no estén ahí).
2. Guía oficial para agentes: `https://api.morsis.com/docs/agents.md`.
3. Implementación de referencia en este repo:
   - `src/morsis-client.js`: cliente HTTP (auth, `Idempotency-Key`, `429`, errores).
   - `src/integration.js`: el flujo de negocio (importar, editar, cobrar, devolver, anular).
   - `test/flow.test.js`: el flujo completo como test contra un Morsis simulado.

## Objetivo

Agregar al sistema destino:

1. Configuración por caja: `baseUrl`, API key (secreto), `branchId`, `externalDeviceId`, cajero
   (`actorUserId`) y datos fiscales del emisor.
2. Un cliente de la API de Morsis aislado en un módulo.
3. Las acciones: elegir cajero, buscar pedido por cupón, cargarlo como venta, quitar línea, cambiar
   cantidad, informar cobro con factura, informar devolución y anulación con nota de crédito.
4. Persistencia de las referencias a Morsis y reintento de los cobros no informados.

Respetá las convenciones del sistema destino (lenguaje, framework, ORM, estilo de tests). Los textos
que ve el cajero van en el idioma del sistema destino.

## Invariantes (no negociables)

- La API key solo existe en el backend, leída de un secreto o variable de entorno. Nunca en el
  frontend, en logs, en el repo ni en mensajes de error.
- Base URL: staging `https://api-staging.morsis.com/v1`, producción `https://api.morsis.com/v1`.
  Header en toda llamada: `Authorization: Bearer <key>`.
- Montos: enteros en **centavos** de ARS. Nunca floats. Moneda siempre `"ARS"`.
- `paymentCouponCode` es **string** (conserva ceros a la izquierda). Nunca lo conviertas a número.
- `actorUserId` = `userId` de `GET /team/members`, **no** `id` (ese es la membresía).
- Todo comando (todo `POST`/`PATCH` sobre `/orders/{id}/…`) lleva en el body
  `actorUserId`, `externalDeviceId` y `expectedVersion`, y el header `Idempotency-Key`.
- `expectedVersion` = el `version` del último pedido leído, opaco y sin modificar. Cada respuesta de
  comando trae el pedido completo: reemplazá la copia local y su `version`.
- Un solo comando a la vez por pedido (serializá; no los mandes en paralelo).
- `Idempotency-Key`:
  - edición de líneas: un UUID nuevo por acción del usuario, reusado si se reintenta esa acción;
  - `external-completion`, `external-refunds`, `external-cancellation`: **igual a
    `externalOperationId`**. Generalo una vez, **persistilo antes de llamar** y reusalo (con el
    mismo body) en cada reintento.
- No recalcules precios: usá `items[].totalCents` y `totalCents` del pedido.
- Nunca mandes número completo de tarjeta ni código de seguridad.

## Endpoints que vas a usar

| Acción | Request | Scope |
|---|---|---|
| Sucursales | `GET /branches` | `branches:read` |
| Cajeros | `GET /team/members?limit=100[&cursor=][&query=]` → `{data, meta:{cursor, hasMore}}` | `team:read` |
| Medios de cobro | `GET /payment-methods` | `payment_methods:read` |
| Buscar por cupón | `GET /orders?paymentCouponCode={code}&branchId={id}` → `data` con 0 o 1 pedido | `orders:read` |
| Cupones pendientes (opcional) | `GET /orders?branchId={id}&hasPaymentCoupon=true&paymentStatus=unpaid&preparationStatus=pending,confirmed,preparing,ready,completed,in_table&limit=20` → resúmenes sin líneas ni `version`; paginar con `meta.cursor` | `orders:read` |
| Releer | `GET /orders/{orderId}` | `orders:read` |
| Quitar línea | `POST /orders/{orderId}/item-removals` `{…ctx, lineItemId}` | `orders:write` |
| Cambiar cantidad | `PATCH /orders/{orderId}/items/{lineItemId}` `{…ctx, quantity>=1}` | `orders:write` |
| Cobro + factura | `POST /orders/{orderId}/external-completion` | `orders:complete_external` |
| Devolución | `POST /orders/{orderId}/external-refunds` | `orders:refund_external` |
| Anulación | `POST /orders/{orderId}/external-cancellation` | `orders:refund_external` |

`ctx` = `{ "actorUserId", "externalDeviceId", "expectedVersion" }`.

Filtrado de cajeros por sucursal: `member.branchIds === null || member.branchIds.includes(branchId)`.
Si `/team/members` devuelve `403` (falta `team:read`), permití cargar el `actorUserId` a mano.

## Payloads de cierre

```jsonc
// POST /orders/{id}/external-completion   (Idempotency-Key = externalOperationId)
{
  "actorUserId": "uuid", "externalDeviceId": "CAJA-1", "expectedVersion": "…",
  "externalOperationId": "venta-<tu-id>",          // <=120 chars, persistido antes de llamar
  "occurredAt": "2026-10-17T10:05:00-03:00",       // ISO con zona, <= ahora + 5 min
  "expectedTotalCents": 980000,                    // = order.totalCents
  "currency": "ARS",
  "payments": [                                    // suma = expectedTotalCents
    { "methodId": "cash|debit_card|credit_card|bank_transfer|qr|payment_link",
      "amountCents": 980000, "reference": "obligatorio",
      "cardBrand": "visa", "cardLastFour": "1234", "installments": 3 }   // solo tarjetas; cuotas solo crédito
  ],
  "invoice": {
    "issuerTaxId": "11 dígitos", "issuerName": "…", "typeCode": 1|6|11|51,
    "pointOfSale": 1, "number": 8421, "issuedOn": "YYYY-MM-DD",
    "totalCents": 980000, "currency": "ARS",
    "authorizationCode": "CAE 14 dígitos (opcional)", "recipientTaxId": "(opcional)"
  }
}
// Respuesta: pedido con paymentStatus "paid" y payments[].id → persistí esos ids.

// POST /orders/{id}/external-refunds   (Idempotency-Key = externalOperationId)
{ …ctx, "externalOperationId": "devolucion-…", "occurredAt": "…", "reason": "…",
  "payments": [ { "paymentId": "payments[].id", "amountCents": 90000 } ],
  "items": [ { "lineItemId": "…", "quantity": 1 } ],          // opcional: solo si vuelve mercadería
  "creditNote": { mismo issuerTaxId que la factura, "typeCode": NC de la misma letra,
                  "totalCents": suma de payments, "issuedOn": >= fecha de la factura, … } }

// POST /orders/{id}/external-cancellation   (Idempotency-Key = externalOperationId)
{ …ctx, "externalOperationId": "anulacion-…", "occurredAt": "…", "reason": "…",
  "creditNote": { …, "totalCents": order.totalCents } }
```

Letra de la nota de crédito según la factura: `1→3`, `6→8`, `11→13`, `51→53`.
Devoluciones y anulaciones solo con la **misma API key** que informó el cobro.
Anulación solo si no hubo devoluciones (`409 ORDER_HAS_REFUNDS`); si las hubo, devolvé el resto.
No existe endpoint para anular un pedido impago: si el cliente se va, descartá la venta localmente.

## Estados

- `paymentStatus`: `unpaid` → `paid` (completion) → `refunded` (devolución total).
- `preparationStatus`: `pending`, `confirmed`, `preparing`, `ready`, `completed`, `cancelled`, `in_table`.
- Editable y cobrable solo si el pedido está abierto y `paymentStatus === "unpaid"`.
- Tratá cualquier valor desconocido como "no editable" sin romper.

## Manejo de errores

Formato: `{ "error": { "code", "message", "details"? } }` + header `X-Request-Id` (logealo siempre).

| Respuesta | Comportamiento requerido |
|---|---|
| `400 VALIDATION_ERROR` | Mostrar el campo (`details[].path`). No reintentar igual. |
| `401` / `403` | Error de configuración (key, scope, sucursal). No reintentar. |
| `404` | Pedido/línea/pago inexistente o fuera de alcance. |
| `409 ORDER_VERSION_CONFLICT` | `GET /orders/{id}`, actualizar la venta, mostrar el cambio; **no** reintentar automáticamente. |
| `409 AMOUNT_MISMATCH` | Releer el pedido; el total cambió. No informar el cobro hasta resolverlo. |
| `409 ORDER_BUSY` | Reintentar con backoff, misma key. |
| `409` otros (`ORDER_NOT_EDITABLE`, `ORDER_HAS_REFUNDS`, `CREDIT_NOTE_MISMATCH`, `IDEMPOTENCY_CONFLICT`, …) | Releer el pedido y mostrar el motivo. |
| `429` | Esperar `Retry-After` segundos y reintentar. |
| `5xx`, timeout, red | Reintentar con la **misma** `Idempotency-Key` y el **mismo** body. |

Regla crítica: si `external-completion` falla por red/timeout/5xx, la plata ya se cobró. Marcá la
venta `pendiente de informar` y reintentá en segundo plano con el mismo `externalOperationId` hasta
obtener una respuesta definitiva. Nunca generes un `externalOperationId` nuevo para el mismo cobro.

## Persistencia mínima

Venta: `morsis_order_id`, `morsis_coupon_code` (string), `morsis_version`, `external_operation_id`,
`morsis_sync_status` (`pendiente|informado|error`). Línea: `morsis_line_item_id`.
Pago: `morsis_payment_id`. Operaciones de devolución/anulación: su propio `external_operation_id`.

## No hagas

- No expongas la API key al navegador ni la imprimas.
- No uses `float` para dinero ni `parseInt` sobre el cupón.
- No uses `member.id` como `actorUserId`.
- No reuses una `Idempotency-Key` con otro body, ni generes una nueva al reintentar.
- No reintentes a ciegas un `409 ORDER_VERSION_CONFLICT`.
- No inventes endpoints (no hay webhooks de pedidos ni endpoint para anular pedidos impagos).
- No uses un resumen de la lista de pedidos para comandos: no trae `version` ni líneas; leé el pedido completo primero.
- No asumas que todas las líneas son editables (`lineItemId: null`, combos, líneas ya en cocina).

## Criterios de aceptación

Antes de dar la tarea por terminada, el sistema destino tiene tests (con un fake HTTP de Morsis o
mocks del cliente) que cubren:

- [ ] Cupón inexistente → mensaje claro, sin venta creada.
- [ ] Cupón con ceros a la izquierda se envía intacto.
- [ ] Importar un pedido copia líneas, totales y cliente sin recalcular.
- [ ] Quitar línea y cambiar cantidad mandan `expectedVersion` y actualizan la `version` local.
- [ ] `409 ORDER_VERSION_CONFLICT` relee el pedido y no reintenta solo.
- [ ] Cobro: suma de pagos = factura = `expectedTotalCents` = `totalCents`.
- [ ] Cobro con timeout se reintenta con el mismo `externalOperationId` e `Idempotency-Key`.
- [ ] Devolución usa `payments[].id` guardado y nota de crédito de la letra correcta.
- [ ] Anulación después de una devolución muestra el error `ORDER_HAS_REFUNDS`.
- [ ] La API key no aparece en respuestas, logs ni bundle del frontend.

Para probar a mano, este repo trae un Morsis simulado: `npm install && npm start`
(sin `MORSIS_API_KEY` arranca en modo simulado) con cupones `012345678`, `000000777` y `123456789`.
