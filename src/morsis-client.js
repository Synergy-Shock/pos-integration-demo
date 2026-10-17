// Cliente HTTP de la API pública de Morsis (v1).
//
// Este archivo es independiente del resto de la demo: copialo a tu sistema y usalo tal cual.
// Solo depende de `fetch` (Node 18+). Documentación: https://api.morsis.com/docs
//
// Reglas que aplica por vos:
//   - Autenticación con `Authorization: Bearer <API key>` (la clave vive SOLO en el servidor).
//   - `Idempotency-Key` obligatorio en todo comando sobre pedidos.
//   - Reintento único ante 429 respetando `Retry-After`.
//   - Errores normalizados en MorsisApiError con `status`, `code`, `details` y `requestId`.

import { randomUUID } from 'node:crypto';

export class MorsisApiError extends Error {
  constructor({ status, code, message, details, requestId }) {
    super(message || code || `HTTP ${status}`);
    this.name = 'MorsisApiError';
    this.status = status;
    this.code = code || `HTTP_${status}`;
    this.details = details;
    this.requestId = requestId;
  }
}

export class MorsisClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey   Clave de la API pública.
   * @param {string} [opts.baseUrl] https://api.morsis.com/v1 o https://api-staging.morsis.com/v1
   * @param {(call: object) => void} [opts.onCall] Se invoca con cada request/response (útil para logs).
   */
  constructor({ apiKey, baseUrl = 'https://api.morsis.com/v1', onCall } = {}) {
    if (!apiKey) throw new Error('MorsisClient: falta apiKey');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.onCall = onCall;
  }

  // ---------------------------------------------------------------- lecturas

  /** GET /branches: sucursales activas (para saber el branchId donde se presenta el cupón). */
  async listBranches() {
    return (await this.#request('GET', '/branches')).data;
  }

  /** GET /payment-methods: IDs de métodos de cobro externo (cash, debit_card, credit_card, ...). */
  async listPaymentMethods() {
    return (await this.#request('GET', '/payment-methods')).data;
  }

  /**
   * GET /team/members: usuarios del equipo del comercio (requiere el scope `team:read`).
   * Recorre todas las páginas. Usá `userId` (no `id`) como actorUserId en los comandos.
   * Un miembro con `branchIds: null` tiene acceso a todas las sucursales.
   */
  async listTeamMembers({ query } = {}) {
    const members = [];
    let cursor = null;
    do {
      const params = new URLSearchParams({ limit: '100' });
      if (query) params.set('query', query);
      if (cursor) params.set('cursor', cursor);
      const res = await this.#request('GET', `/team/members?${params}`);
      members.push(...res.data);
      cursor = res.meta?.hasMore ? res.meta.cursor : null;
    } while (cursor);
    return members;
  }

  /**
   * GET /orders?paymentCouponCode=&branchId=
   * Busca el pedido de un cupón de pago. Devuelve el pedido o null si el cupón no existe.
   * El código se manda como string para conservar los ceros a la izquierda.
   */
  async findOrderByCoupon(paymentCouponCode, branchId) {
    const query = new URLSearchParams({ paymentCouponCode: String(paymentCouponCode), branchId });
    const res = await this.#request('GET', `/orders?${query}`);
    return res.data[0] ?? null;
  }

  /** GET /orders/{orderId}: relee el pedido (por ejemplo después de un 409). */
  async getOrder(orderId) {
    return (await this.#request('GET', `/orders/${orderId}`)).data;
  }

  // ---------------------------------------------------------------- edición
  // Todos los comandos llevan `ctx` = { actorUserId, externalDeviceId, expectedVersion }.
  // expectedVersion es el `version` del último pedido que leíste; mandalo sin modificar.
  // Cada comando devuelve el pedido actualizado: guardá su nuevo `version` para el siguiente.

  /** PATCH /orders/{id}/items/{lineItemId}: cambia cantidad, opciones o notas de una línea. */
  async updateOrderItem(orderId, lineItemId, ctx, changes, idempotencyKey = randomUUID()) {
    return (
      await this.#request('PATCH', `/orders/${orderId}/items/${lineItemId}`, {
        body: { ...ctx, ...changes },
        idempotencyKey,
      })
    ).data;
  }

  /** POST /orders/{id}/item-removals: quita una línea completa. */
  async removeOrderItem(orderId, lineItemId, ctx, idempotencyKey = randomUUID()) {
    return (
      await this.#request('POST', `/orders/${orderId}/item-removals`, {
        body: { ...ctx, lineItemId },
        idempotencyKey,
      })
    ).data;
  }

  /** POST /orders/{id}/items: agrega un producto del catálogo de la sucursal. */
  async addOrderItem(orderId, ctx, item, idempotencyKey = randomUUID()) {
    return (
      await this.#request('POST', `/orders/${orderId}/items`, {
        body: { ...ctx, ...item },
        idempotencyKey,
      })
    ).data;
  }

  // ---------------------------------------------------------------- cierre y reversas
  // En estos tres comandos el Idempotency-Key DEBE ser igual a body.externalOperationId.
  // Generá ese ID una vez por operación, guardalo en tu base y reusalo en los reintentos.

  /** POST /orders/{id}/external-completion: informa cobro + factura externos y cierra el pedido. */
  async completeOrderExternally(orderId, body) {
    return (
      await this.#request('POST', `/orders/${orderId}/external-completion`, {
        body,
        idempotencyKey: body.externalOperationId,
      })
    ).data;
  }

  /** POST /orders/{id}/external-refunds: informa una devolución parcial o total + nota de crédito. */
  async refundOrderExternally(orderId, body) {
    return (
      await this.#request('POST', `/orders/${orderId}/external-refunds`, {
        body,
        idempotencyKey: body.externalOperationId,
      })
    ).data;
  }

  /** POST /orders/{id}/external-cancellation: informa la anulación total + nota de crédito. */
  async cancelOrderExternally(orderId, body) {
    return (
      await this.#request('POST', `/orders/${orderId}/external-cancellation`, {
        body,
        idempotencyKey: body.externalOperationId,
      })
    ).data;
  }

  // ---------------------------------------------------------------- transporte

  async #request(method, path, { body, idempotencyKey } = {}, attempt = 1) {
    const headers = { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const startedAt = Date.now();
    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const requestId = res.headers.get('x-request-id');
    const text = await res.text();
    const json = text ? safeJson(text) : null;

    this.onCall?.({
      method,
      path,
      idempotencyKey,
      requestBody: body,
      status: res.status,
      responseBody: json ?? text,
      requestId,
      durationMs: Date.now() - startedAt,
    });

    if (res.status === 429 && attempt === 1) {
      const waitSeconds = Number(res.headers.get('retry-after')) || 1;
      await new Promise((r) => setTimeout(r, waitSeconds * 1000));
      return this.#request(method, path, { body, idempotencyKey }, attempt + 1);
    }

    if (!res.ok) {
      const err = json?.error ?? {};
      throw new MorsisApiError({
        status: res.status,
        code: err.code,
        message: err.message,
        details: err.details,
        requestId,
      });
    }
    return json;
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
