// Morsis simulado en memoria, para probar el flujo sin API key.
//
// Expone exactamente los mismos métodos que MorsisClient y devuelve pedidos con la misma forma
// que la API real, incluyendo sus reglas principales:
//   - control de versión (409 ORDER_VERSION_CONFLICT si expectedVersion no es el actual)
//   - solo se editan / cierran pedidos abiertos e impagos (409 ORDER_NOT_EDITABLE)
//   - el cobro y la factura deben sumar exactamente el total (409 AMOUNT_MISMATCH)
//   - idempotencia: misma key + mismo body = misma respuesta; otro body = 409 IDEMPOTENCY_CONFLICT
//   - anular un pedido con devoluciones = 409 ORDER_HAS_REFUNDS
// No reemplaza probar contra staging: la API real tiene más validaciones.

import { randomUUID } from 'node:crypto';
import { MorsisApiError } from './morsis-client.js';

const BRANCHES = [
  { id: '55555555-5555-4555-8555-555555555555', name: 'Sucursal Centro', displayName: 'El Gauchito Centro' },
  { id: '56565656-5656-4565-8565-565656565656', name: 'Sucursal Palermo', displayName: 'El Gauchito Palermo' },
];

const TEAM = [
  member('Sofía Ramírez', 'sofia@elgauchito.com.ar', 'Cajero', 'Caja principal', [BRANCHES[0].id]),
  member('Martín López', 'martin@elgauchito.com.ar', 'Cajero', 'Turno noche', [BRANCHES[0].id, BRANCHES[1].id]),
  member('Carla Fernández', 'carla@elgauchito.com.ar', 'Encargada', 'Encargada de local', null),
  member('Diego Torres', 'diego@elgauchito.com.ar', 'Cajero', null, [BRANCHES[1].id]),
];

function member(name, email, role, jobTitle, branchIds) {
  return { id: randomUUID(), userId: randomUUID(), name, email, role, roleId: randomUUID(), jobTitle, branchIds, joinedAt: '2026-03-02T12:00:00.000Z' };
}

const PAYMENT_METHODS = [
  { id: 'cash', name: 'Efectivo', requiredFields: ['reference'] },
  { id: 'debit_card', name: 'Tarjeta de débito', requiredFields: ['reference'] },
  { id: 'credit_card', name: 'Tarjeta de crédito', requiredFields: ['reference'] },
  { id: 'bank_transfer', name: 'Transferencia bancaria', requiredFields: ['reference'] },
  { id: 'qr', name: 'QR', requiredFields: ['reference'] },
  { id: 'payment_link', name: 'Link de pago', requiredFields: ['reference'] },
];

// Cupones de ejemplo. Cualquier otro código responde "sin resultados".
function seedOrders() {
  const branchId = BRANCHES[0].id;
  return [
    buildOrder({
      orderNumber: '1042',
      coupon: '012345678',
      branchId,
      serviceMode: 'takeaway',
      customer: {
        id: randomUUID(),
        name: 'María González',
        email: 'maria@example.com',
        phone: '+54 9 11 5555-1234',
        taxId: null,
        taxIdType: null,
        fiscalName: null,
        ivaCondition: 'consumidor_final',
        fiscalAddress: null,
      },
      items: [
        line('Café con leche', 'CAFE-01', 1, 250000, 21, [opt('Leche', 'Avena', 30000, 'increase')]),
        line('Medialuna de manteca', 'MED-01', 3, 90000, 21),
        line('Tostado de jamón y queso', 'TOS-02', 1, 520000, 21, [], 'Bien tostado'),
        line('Jugo de naranja exprimido', 'JUG-01', 1, 380000, 21),
      ],
    }),
    buildOrder({
      orderNumber: '1043',
      coupon: '000000777',
      branchId,
      serviceMode: 'delivery',
      deliveryFeeCents: 150000,
      customer: null,
      items: [
        line('Pizza muzzarella grande', 'PIZ-01', 1, 1250000, 21),
        line('Empanada de carne', 'EMP-01', 6, 180000, 21, [opt('Cocción', 'Al horno', 0, 'none')]),
        line('Agua sin gas 500 ml', 'AGU-01', 2, 150000, 21),
      ],
    }),
    buildOrder({
      orderNumber: '1044',
      coupon: '123456789',
      branchId: BRANCHES[1].id,
      serviceMode: 'dine_in',
      customer: null,
      items: [line('Bife de chorizo', 'BIF-01', 2, 1890000, 21), line('Ensalada mixta', 'ENS-01', 1, 450000, 10.5)],
    }),
  ];
}

function line(name, sku, quantity, priceCents, taxRate, options = [], notes = null) {
  return { lineItemId: randomUUID(), productId: randomUUID(), sku, name, quantity, priceCents, taxRate, weightKg: null, notes, options };
}

function opt(optionGroupName, name, priceCents, modifierType) {
  return { optionId: randomUUID(), optionGroupId: randomUUID(), optionGroupName, name, priceCents, modifierType, quantity: 1 };
}

function buildOrder({ orderNumber, coupon, branchId, serviceMode, customer, items, deliveryFeeCents = 0 }) {
  const order = {
    id: randomUUID(),
    orderNumber,
    branchId,
    paymentCoupon: { code: coupon },
    version: '',
    currency: 'ARS',
    subtotalCents: 0,
    discountCents: 0,
    deliveryFeeCents,
    totalCents: 0,
    taxBreakdown: [],
    preparationStatus: 'pending',
    fulfillmentStatus: null,
    paymentStatus: 'unpaid',
    serviceMode,
    createdAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    completedAt: null,
    cancelledAt: null,
    customer,
    items,
    payments: [],
    refunds: [],
    invoices: [],
  };
  recalc(order);
  bumpVersion(order);
  return order;
}

function lineTotal(item) {
  let unit = item.priceCents;
  for (const o of item.options) {
    if (o.modifierType === 'increase') unit += o.priceCents * o.quantity;
    if (o.modifierType === 'decrease') unit -= o.priceCents * o.quantity;
    if (o.modifierType === 'replace') unit = o.priceCents;
  }
  return unit * item.quantity;
}

function recalc(order) {
  for (const item of order.items) item.totalCents = lineTotal(item);
  order.subtotalCents = order.items.reduce((s, i) => s + i.totalCents, 0);
  order.totalCents = order.subtotalCents - order.discountCents + order.deliveryFeeCents;
  const byRate = new Map();
  for (const item of order.items) byRate.set(item.taxRate ?? 21, (byRate.get(item.taxRate ?? 21) ?? 0) + item.totalCents);
  if (order.deliveryFeeCents) byRate.set(21, (byRate.get(21) ?? 0) + order.deliveryFeeCents);
  order.taxBreakdown = [...byRate].map(([rate, gross]) => {
    const netCents = Math.round(gross / (1 + rate / 100));
    return { rate, netCents, taxCents: gross - netCents };
  });
}

let versionCounter = 0;
function bumpVersion(order) {
  versionCounter += 1;
  order.version = Buffer.from(`${new Date().toISOString()}#${versionCounter}`).toString('base64url');
}

const clone = (x) => structuredClone(x);
const conflict = (code, message) => new MorsisApiError({ status: 409, code, message, requestId: randomUUID() });
const notFound = (code = 'NOT_FOUND', message = 'Order not found') =>
  new MorsisApiError({ status: 404, code, message, requestId: randomUUID() });
const invalid = (path, message) =>
  new MorsisApiError({
    status: 400,
    code: 'VALIDATION_ERROR',
    message: `${path}: ${message}`,
    details: [{ path, message }],
    requestId: randomUUID(),
  });

export class MockMorsis {
  constructor({ onCall } = {}) {
    this.onCall = onCall;
    this.reset();
  }

  /** Vuelve los pedidos de ejemplo a su estado inicial. */
  reset() {
    this.orders = seedOrders();
    this.idempotency = new Map(); // key -> { bodyJson, response }
  }

  /** Solo demo: simula que alguien editó el pedido en Morsis, para ver un 409 de versión. */
  simulateConcurrentEdit(orderId) {
    const order = this.#find(orderId);
    bumpVersion(order);
    return clone(order);
  }

  async listBranches() {
    return this.#call('GET', '/branches', {}, () => ({ data: clone(BRANCHES) })).data;
  }

  async listTeamMembers({ query } = {}) {
    const path = `/team/members?${new URLSearchParams({ limit: '100', ...(query ? { query } : {}) })}`;
    return this.#call('GET', path, {}, () => {
      const q = (query ?? '').toLowerCase();
      const data = TEAM.filter((m) => !q || `${m.name} ${m.email}`.toLowerCase().includes(q));
      return { data: clone(data), meta: { cursor: null, hasMore: false } };
    }).data;
  }

  async listPaymentMethods() {
    return this.#call('GET', '/payment-methods', {}, () => ({ data: clone(PAYMENT_METHODS) })).data;
  }

  async findOrderByCoupon(paymentCouponCode, branchId) {
    const query = new URLSearchParams({ paymentCouponCode: String(paymentCouponCode), branchId });
    const res = this.#call('GET', `/orders?${query}`, {}, () => {
      if (!/^[0-9]+$/.test(String(paymentCouponCode))) throw invalid('paymentCouponCode', 'Must contain only digits');
      const found = this.orders.filter((o) => o.paymentCoupon?.code === String(paymentCouponCode) && o.branchId === branchId);
      return { data: clone(found), meta: { cursor: found.at(-1)?.id ?? null, hasMore: false, total: found.length } };
    });
    return res.data[0] ?? null;
  }

  async getOrder(orderId) {
    return this.#call('GET', `/orders/${orderId}`, {}, () => ({ data: clone(this.#find(orderId)) })).data;
  }

  async updateOrderItem(orderId, lineItemId, ctx, changes, idempotencyKey = randomUUID()) {
    const body = { ...ctx, ...changes };
    return this.#command('PATCH', `/orders/${orderId}/items/${lineItemId}`, body, idempotencyKey, () => {
      const order = this.#editable(orderId, ctx);
      const item = order.items.find((i) => i.lineItemId === lineItemId);
      if (!item) throw notFound('ITEM_NOT_FOUND', 'Item not found');
      if (changes.quantity !== undefined) {
        if (!Number.isInteger(changes.quantity) || changes.quantity < 1) throw invalid('quantity', 'Must be a positive integer');
        item.quantity = changes.quantity;
      }
      if (changes.notes !== undefined) item.notes = changes.notes || null;
      return this.#commit(order);
    });
  }

  async removeOrderItem(orderId, lineItemId, ctx, idempotencyKey = randomUUID()) {
    const body = { ...ctx, lineItemId };
    return this.#command('POST', `/orders/${orderId}/item-removals`, body, idempotencyKey, () => {
      const order = this.#editable(orderId, ctx);
      const index = order.items.findIndex((i) => i.lineItemId === lineItemId);
      if (index === -1) throw notFound('ITEM_NOT_FOUND', 'Item not found');
      order.items.splice(index, 1);
      return this.#commit(order);
    });
  }

  async addOrderItem() {
    throw new MorsisApiError({ status: 501, code: 'NOT_IMPLEMENTED', message: 'El modo demo no simula agregar productos' });
  }

  async completeOrderExternally(orderId, body) {
    return this.#command('POST', `/orders/${orderId}/external-completion`, body, body.externalOperationId, (key) => {
      if (key !== body.externalOperationId) throw invalid('Idempotency-Key', 'Must equal externalOperationId');
      const order = this.#editable(orderId, body);
      if (!order.items.length) throw conflict('ORDER_NOT_EDITABLE', 'The order has no items');
      const paid = body.payments.reduce((s, p) => s + p.amountCents, 0);
      if (body.expectedTotalCents !== order.totalCents || paid !== order.totalCents || body.invoice.totalCents !== order.totalCents) {
        throw conflict('AMOUNT_MISMATCH', 'Payments, invoice total and expectedTotalCents must equal the order total');
      }
      for (const p of body.payments) {
        const isCard = p.methodId === 'debit_card' || p.methodId === 'credit_card';
        order.payments.push({
          id: randomUUID(),
          status: 'approved',
          collectedBy: 'external',
          methodId: p.methodId,
          amountCents: p.amountCents,
          currency: 'ARS',
          reference: p.reference,
          authorizationCode: p.authorizationCode ?? null,
          card: isCard
            ? { type: p.methodId === 'credit_card' ? 'credit' : 'debit', brand: p.cardBrand ?? null, lastFour: p.cardLastFour ?? null, installments: p.installments ?? null }
            : null,
          bank: p.bank ?? null,
          occurredAt: body.occurredAt,
          externalOperationId: body.externalOperationId,
          externalDeviceId: body.externalDeviceId,
          settlementStatus: 'pending',
        });
      }
      order.invoices.push(toInvoice(body.invoice, 'invoice'));
      order.paymentStatus = 'paid';
      order.completedAt = new Date().toISOString();
      return this.#commit(order);
    });
  }

  async refundOrderExternally(orderId, body) {
    return this.#command('POST', `/orders/${orderId}/external-refunds`, body, body.externalOperationId, () => {
      const order = this.#reversible(orderId, body);
      const total = body.payments.reduce((s, p) => s + p.amountCents, 0);
      if (total !== body.creditNote.totalCents) throw conflict('CREDIT_NOTE_MISMATCH', 'Credit note total must equal the refunded amount');
      for (const p of body.payments) {
        const payment = order.payments.find((x) => x.id === p.paymentId);
        if (!payment) throw notFound('PAYMENT_NOT_FOUND', 'Payment not found');
        if (p.amountCents > payment.amountCents - refundedOf(order, payment.id)) {
          throw conflict('AMOUNT_MISMATCH', 'Refund exceeds what is left of the payment');
        }
      }
      for (const p of body.payments) {
        order.refunds.push(toRefund(order, p, body));
      }
      order.invoices.push(toInvoice(body.creditNote, 'credit_note'));
      if (order.refunds.reduce((s, r) => s + r.amountCents, 0) >= order.payments.reduce((s, p) => s + p.amountCents, 0)) {
        order.paymentStatus = 'refunded';
      }
      return this.#commit(order, { recalc: false });
    });
  }

  async cancelOrderExternally(orderId, body) {
    return this.#command('POST', `/orders/${orderId}/external-cancellation`, body, body.externalOperationId, () => {
      const order = this.#reversible(orderId, body);
      if (order.refunds.length) throw conflict('ORDER_HAS_REFUNDS', 'Refund the rest instead of cancelling');
      if (body.creditNote.totalCents !== order.totalCents) throw conflict('CREDIT_NOTE_MISMATCH', 'Credit note must equal the order total');
      for (const payment of order.payments) {
        order.refunds.push(toRefund(order, { paymentId: payment.id, amountCents: payment.amountCents }, body));
      }
      order.invoices.push(toInvoice(body.creditNote, 'credit_note'));
      order.paymentStatus = 'refunded';
      order.preparationStatus = 'cancelled';
      order.cancelledAt = new Date().toISOString();
      return this.#commit(order, { recalc: false });
    });
  }

  // ---------------------------------------------------------------- internos

  #find(orderId) {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order) throw notFound();
    return order;
  }

  #checkVersion(order, ctx) {
    if (ctx.expectedVersion !== order.version) throw conflict('ORDER_VERSION_CONFLICT', 'Read the order again before changing it');
  }

  #editable(orderId, ctx) {
    const order = this.#find(orderId);
    this.#checkVersion(order, ctx);
    if (order.paymentStatus !== 'unpaid' || order.cancelledAt) throw conflict('ORDER_NOT_EDITABLE', 'Only open unpaid orders can be changed');
    return order;
  }

  #reversible(orderId, ctx) {
    const order = this.#find(orderId);
    this.#checkVersion(order, ctx);
    const external = order.payments.some((p) => p.collectedBy === 'external');
    if (!external || order.cancelledAt || order.paymentStatus === 'refunded') {
      throw conflict('ORDER_NOT_REVERSIBLE', 'Only externally completed sales can be reversed');
    }
    return order;
  }

  #commit(order, { recalc: doRecalc = true } = {}) {
    if (doRecalc) recalc(order);
    bumpVersion(order);
    return { data: clone(order) };
  }

  #command(method, path, body, idempotencyKey, run) {
    return this.#call(method, path, { body, idempotencyKey }, () => {
      if (!idempotencyKey) throw invalid('Idempotency-Key', 'Required');
      const bodyJson = JSON.stringify(body);
      const previous = this.idempotency.get(idempotencyKey);
      if (previous) {
        if (previous.bodyJson !== bodyJson) throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency-Key reused with a different payload');
        return clone(previous.response);
      }
      const response = run(idempotencyKey);
      this.idempotency.set(idempotencyKey, { bodyJson, response: clone(response) });
      return response;
    }).data;
  }

  // Registra la "llamada" con la misma forma que MorsisClient para que la UI la muestre igual.
  #call(method, path, { body, idempotencyKey } = {}, run) {
    const startedAt = Date.now();
    const requestId = randomUUID();
    let status = method === 'POST' && path.endsWith('/items') ? 201 : 200;
    let responseBody;
    try {
      responseBody = run();
      return responseBody;
    } catch (err) {
      if (!(err instanceof MorsisApiError)) throw err;
      status = err.status;
      err.requestId = requestId;
      responseBody = { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
      throw err;
    } finally {
      this.onCall?.({
        method,
        path,
        idempotencyKey,
        requestBody: body,
        status,
        responseBody,
        requestId,
        durationMs: Date.now() - startedAt,
        mock: true,
      });
    }
  }
}

function refundedOf(order, paymentId) {
  return order.refunds.filter((r) => r.paymentId === paymentId).reduce((s, r) => s + r.amountCents, 0);
}

function toRefund(order, p, body) {
  return {
    id: randomUUID(),
    paymentId: p.paymentId,
    status: 'completed',
    refundedBy: 'external',
    amountCents: p.amountCents,
    currency: 'ARS',
    occurredAt: body.occurredAt,
    externalOperationId: body.externalOperationId,
    items: body.items ?? [],
  };
}

function toInvoice(doc, documentType) {
  return {
    issuedBy: 'external',
    documentType,
    issuerTaxId: doc.issuerTaxId,
    issuerName: doc.issuerName,
    typeCode: doc.typeCode,
    pointOfSale: doc.pointOfSale,
    number: doc.number,
    issuedOn: doc.issuedOn,
    totalCents: doc.totalCents,
    currency: doc.currency,
    authorizationCode: doc.authorizationCode ?? null,
    authorizationExpiresOn: doc.authorizationExpiresOn ?? null,
    recipientTaxId: doc.recipientTaxId ?? null,
    recipientName: doc.recipientName ?? null,
    documentUrl: doc.documentUrl ?? null,
  };
}
