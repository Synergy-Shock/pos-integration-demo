// Flujo de integración del lado del sistema externo (POS).
//
// Acá está la lógica que tu sistema tiene que implementar, paso a paso. Cada función recibe
// un cliente de Morsis (real o simulado: misma interfaz) y devuelve el pedido actualizado.
//
//   1. importSaleFromCoupon  → escaneo del cupón, búsqueda del pedido y armado de la venta local
//   2. removeLine / setLineQuantity → edición de la venta (se refleja en Morsis)
//   3. completeSale          → cobro en tu sistema + factura propia, informados a Morsis
//   4. refundSale / cancelSale → devolución parcial o anulación total de una venta ya cobrada
//
// Regla de oro: guardá siempre el `version` del último pedido que recibiste y mandalo como
// expectedVersion en el siguiente comando. Si Morsis responde 409 ORDER_VERSION_CONFLICT,
// el pedido cambió en Morsis: releelo, mostrale la diferencia al cajero y recién ahí reintentá.

import { randomUUID } from 'node:crypto';

/**
 * Datos de auditoría que viajan en cada comando.
 * actorUserId es el UUID del usuario de Morsis creado para tus operadores (Morsis lo pide en todo
 * comando y responde VALIDATION_ERROR si falta). Validalo al configurar tu sistema, no al cobrar.
 */
export function commandContext(config, order) {
  return {
    actorUserId: config.actorUserId,
    externalDeviceId: config.externalDeviceId,
    expectedVersion: order.version,
  };
}

// ------------------------------------------------------------------ 0. cajeros

/**
 * Cajeros que pueden operar en una sucursal: miembros del equipo con acceso a ella
 * (branchIds null = todas las sucursales). Guardá el `userId` elegido como actorUserId.
 */
export async function listCashiers(morsis, branchId) {
  const members = await morsis.listTeamMembers();
  return members
    .filter((m) => m.branchIds === null || !branchId || m.branchIds.includes(branchId))
    .sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email, 'es'));
}

// ------------------------------------------------------------------ 1. cupón → venta

/**
 * Busca el pedido del cupón y lo convierte en una venta del POS.
 * Devuelve { order, sale } o lanza un error con code COUPON_NOT_FOUND.
 */
export async function importSaleFromCoupon(morsis, { couponCode, branchId }) {
  // El código de barras se trata como texto: "012345678" no es lo mismo que 12345678.
  const code = String(couponCode).trim();
  const order = await morsis.findOrderByCoupon(code, branchId);
  if (!order) {
    const err = new Error(`No hay ningún pedido con el cupón ${code} en esta sucursal`);
    err.code = 'COUPON_NOT_FOUND';
    throw err;
  }
  return { order, sale: orderToSale(order) };
}

/**
 * Traduce un pedido de Morsis al modelo de venta de tu POS. Adaptalo a tus tablas.
 * Guardá siempre orderId, lineItemId y version: son las referencias para hablar con Morsis.
 */
export function orderToSale(order) {
  return {
    morsisOrderId: order.id,
    morsisVersion: order.version,
    reference: `Pedido #${order.orderNumber ?? '-'} · cupón ${order.paymentCoupon?.code ?? '-'}`,
    customer: order.customer
      ? { name: order.customer.name, taxId: order.customer.taxId, ivaCondition: order.customer.ivaCondition }
      : null,
    lines: order.items.map((item) => ({
      morsisLineItemId: item.lineItemId, // null en líneas antiguas: son de solo lectura
      sku: item.sku,
      description: [item.name, ...item.options.map((o) => `${o.optionGroupName ?? ''}: ${o.name}`.trim())].join(' · '),
      quantity: item.quantity,
      unitPriceCents: item.priceCents,
      totalCents: item.totalCents, // el total de la línea que manda Morsis es el que vale
      taxRate: item.taxRate ?? 21,
      notes: item.notes,
    })),
    deliveryFeeCents: order.deliveryFeeCents,
    discountCents: order.discountCents,
    totalCents: order.totalCents,
    taxBreakdown: order.taxBreakdown,
  };
}

// ------------------------------------------------------------------ 2. edición de líneas

/** Quita una línea completa del pedido. */
export function removeLine(morsis, config, order, lineItemId) {
  return morsis.removeOrderItem(order.id, lineItemId, commandContext(config, order));
}

/** Cambia la cantidad de una línea (debe ser >= 1; para 0 usá removeLine). */
export function setLineQuantity(morsis, config, order, lineItemId, quantity) {
  if (quantity < 1) return removeLine(morsis, config, order, lineItemId);
  return morsis.updateOrderItem(order.id, lineItemId, commandContext(config, order), { quantity });
}

// ------------------------------------------------------------------ 3. cobro

/**
 * Informa a Morsis que la venta se cobró y facturó en tu sistema.
 *
 * `payments`: [{ methodId, amountCents, reference, cardBrand?, cardLastFour?, installments? }]
 * `invoice`:  la factura que emitió TU sistema (número, punto de venta, CAE, etc.).
 *
 * Importante: externalOperationId identifica esta operación en tu sistema. Generalo una sola
 * vez, guardalo antes de llamar y reusalo si tenés que reintentar (timeout, caída de red):
 * Morsis devuelve el mismo resultado sin duplicar el cobro.
 */
export function completeSale(morsis, config, order, { payments, invoice, externalOperationId }) {
  const body = {
    ...commandContext(config, order),
    externalOperationId: externalOperationId ?? `venta-${order.orderNumber ?? 'x'}-${randomUUID().slice(0, 8)}`,
    occurredAt: new Date().toISOString(),
    expectedTotalCents: order.totalCents,
    currency: 'ARS',
    payments: payments.map(cleanPayment),
    invoice: {
      issuerTaxId: config.invoice.issuerTaxId,
      issuerName: config.invoice.issuerName,
      typeCode: config.invoice.typeCode,
      pointOfSale: config.invoice.pointOfSale,
      issuedOn: todayInArgentina(),
      totalCents: order.totalCents,
      currency: 'ARS',
      ...invoice,
    },
  };
  return morsis.completeOrderExternally(order.id, body);
}

// ------------------------------------------------------------------ 4. reversas

/**
 * Devolución parcial o total de una venta ya cobrada.
 * `payments`: [{ paymentId, amountCents }] con paymentId = order.payments[].id
 * `items` (opcional): [{ lineItemId, quantity }] si se devolvió mercadería.
 * La nota de crédito debe sumar lo devuelto y tener la letra de la factura (B 6 → NC B 8).
 */
export function refundSale(morsis, config, order, { payments, items, reason, creditNote, externalOperationId }) {
  const totalCents = payments.reduce((s, p) => s + p.amountCents, 0);
  const body = {
    ...commandContext(config, order),
    externalOperationId: externalOperationId ?? `devolucion-${order.orderNumber ?? 'x'}-${randomUUID().slice(0, 8)}`,
    occurredAt: new Date().toISOString(),
    ...(reason ? { reason } : {}),
    payments,
    ...(items?.length ? { items } : {}),
    creditNote: buildCreditNote(config, order, totalCents, creditNote),
  };
  return morsis.refundOrderExternally(order.id, body);
}

/** Anulación total de una venta cobrada (si ya tuvo devoluciones, devolvé el resto con refundSale). */
export function cancelSale(morsis, config, order, { reason, creditNote, externalOperationId }) {
  const body = {
    ...commandContext(config, order),
    externalOperationId: externalOperationId ?? `anulacion-${order.orderNumber ?? 'x'}-${randomUUID().slice(0, 8)}`,
    occurredAt: new Date().toISOString(),
    reason,
    creditNote: buildCreditNote(config, order, order.totalCents, creditNote),
  };
  return morsis.cancelOrderExternally(order.id, body);
}

// ------------------------------------------------------------------ helpers

// Factura → nota de crédito de la misma letra (A 1→3, B 6→8, C 11→13, M 51→53).
const CREDIT_NOTE_FOR_INVOICE = { 1: 3, 6: 8, 11: 13, 51: 53 };

function buildCreditNote(config, order, totalCents, overrides = {}) {
  const invoice = order.invoices.find((i) => i.documentType === 'invoice' && i.issuedBy === 'external');
  const typeCode = CREDIT_NOTE_FOR_INVOICE[invoice?.typeCode ?? config.invoice.typeCode] ?? 8;
  return {
    issuerTaxId: invoice?.issuerTaxId ?? config.invoice.issuerTaxId, // mismo CUIT que la factura
    issuerName: invoice?.issuerName ?? config.invoice.issuerName,
    typeCode,
    pointOfSale: config.invoice.pointOfSale,
    issuedOn: todayInArgentina(), // no puede ser anterior a la factura
    totalCents,
    currency: 'ARS',
    ...overrides,
  };
}

// Solo se mandan los campos de tarjeta cuando corresponden; nunca el número completo ni el CVV.
function cleanPayment(p) {
  const isCard = p.methodId === 'debit_card' || p.methodId === 'credit_card';
  const out = { methodId: p.methodId, amountCents: p.amountCents, reference: p.reference };
  if (p.authorizationCode) out.authorizationCode = p.authorizationCode;
  if (isCard && p.cardLastFour) out.cardLastFour = p.cardLastFour;
  if (isCard && p.cardBrand) out.cardBrand = p.cardBrand;
  if (p.methodId === 'credit_card' && p.installments) out.installments = Number(p.installments);
  if (p.bank) out.bank = p.bank;
  return out;
}

/** Fecha YYYY-MM-DD en hora argentina (para issuedOn de facturas y notas de crédito). */
export function todayInArgentina() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
}
