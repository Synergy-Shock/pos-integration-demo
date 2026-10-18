// Recorre el flujo completo contra el Morsis simulado: cupón → edición → cobro → devolución → anulación.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockMorsis } from '../src/mock-morsis.js';
import * as integration from '../src/integration.js';

const config = {
  actorUserId: '09af74bb-63d8-47f2-8849-d66fe2b98f37',
  externalDeviceId: 'CAJA-TEST',
  invoice: { issuerTaxId: '30712345678', issuerName: 'Test SA', typeCode: 6, pointOfSale: 1 },
};
const BRANCH = '55555555-5555-4555-8555-555555555555';
const cash = (amountCents) => [{ methodId: 'cash', amountCents, reference: 'caja-1' }];

test('cupón inexistente', async () => {
  const morsis = new MockMorsis();
  await assert.rejects(integration.importSaleFromCoupon(morsis, { couponCode: '999', branchId: BRANCH }), { code: 'COUPON_NOT_FOUND' });
});

test('importar, quitar ítem, cobrar, devolver parcial', async () => {
  const morsis = new MockMorsis();
  let { order, sale } = await integration.importSaleFromCoupon(morsis, { couponCode: '012345678', branchId: BRANCH });
  assert.equal(sale.lines.length, 4);
  const before = order.totalCents;

  const juice = order.items.find((i) => i.sku === 'JUG-01');
  order = await integration.removeLine(morsis, config, order, juice.lineItemId);
  assert.equal(order.items.length, 3);
  assert.equal(order.totalCents, before - juice.totalCents);

  const med = order.items.find((i) => i.sku === 'MED-01');
  order = await integration.setLineQuantity(morsis, config, order, med.lineItemId, 2);
  assert.equal(order.items.find((i) => i.sku === 'MED-01').quantity, 2);

  await assert.rejects(
    integration.completeSale(morsis, config, order, { payments: cash(order.totalCents - 1), invoice: { number: 1 } }),
    { code: 'AMOUNT_MISMATCH' },
  );
  order = await morsis.getOrder(order.id);
  order = await integration.completeSale(morsis, config, order, { payments: cash(order.totalCents), invoice: { number: 1 } });
  assert.equal(order.paymentStatus, 'paid');
  assert.equal(order.invoices[0].documentType, 'invoice');

  await assert.rejects(integration.removeLine(morsis, config, order, med.lineItemId), { code: 'ORDER_NOT_EDITABLE' });

  order = await integration.refundSale(morsis, config, order, {
    payments: [{ paymentId: order.payments[0].id, amountCents: 90000 }],
    items: [{ lineItemId: med.lineItemId, quantity: 1 }],
    creditNote: { number: 2 },
  });
  assert.equal(order.refunds.length, 1);
  assert.equal(order.invoices[1].typeCode, 8);
  await assert.rejects(integration.cancelSale(morsis, config, order, { reason: 'x', creditNote: { number: 3 } }), { code: 'ORDER_HAS_REFUNDS' });
});

test('anulación total y conflicto de versión', async () => {
  const morsis = new MockMorsis();
  let { order } = await integration.importSaleFromCoupon(morsis, { couponCode: '000000777', branchId: BRANCH });
  morsis.simulateConcurrentEdit(order.id);
  await assert.rejects(integration.removeLine(morsis, config, order, order.items[0].lineItemId), { code: 'ORDER_VERSION_CONFLICT' });
  order = await morsis.getOrder(order.id);
  order = await integration.completeSale(morsis, config, order, { payments: cash(order.totalCents), invoice: { number: 10 } });
  order = await integration.cancelSale(morsis, config, order, { reason: 'Desistió', creditNote: { number: 11 } });
  assert.ok(order.cancelledAt);
  assert.equal(order.paymentStatus, 'refunded');
});

test('idempotencia: reintento con la misma key devuelve lo mismo', async () => {
  const morsis = new MockMorsis();
  const { order } = await integration.importSaleFromCoupon(morsis, { couponCode: '000000777', branchId: BRANCH });
  const args = { payments: cash(order.totalCents), invoice: { number: 20 }, externalOperationId: 'venta-fija-1' };
  const a = await integration.completeSale(morsis, config, order, args);
  // Mismo body (incluido occurredAt) y misma key: Morsis repite la respuesta sin cobrar dos veces.
  const sameBody = JSON.parse(morsis.idempotency.get('venta-fija-1').bodyJson);
  const b = await morsis.completeOrderExternally(order.id, sameBody);
  assert.equal(a.version, b.version);
  assert.equal(b.payments.length, 1);
  await assert.rejects(morsis.completeOrderExternally(order.id, { ...sameBody, reason: 'otro' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('cajeros: solo los que tienen acceso a la sucursal', async () => {
  const morsis = new MockMorsis();
  const centro = await integration.listCashiers(morsis, BRANCH);
  const names = centro.map((m) => m.name);
  assert.ok(names.includes('Sofía Ramírez'));
  assert.ok(names.includes('Carla Fernández')); // branchIds null = todas las sucursales
  assert.ok(!names.includes('Diego Torres')); // solo Palermo
  assert.match(centro[0].userId, /^[0-9a-f-]{36}$/);
});

test('cupones pendientes: solo impagos de la sucursal, y el cobrado sale de la lista', async () => {
  const morsis = new MockMorsis();
  let res = await integration.listPendingCoupons(morsis, BRANCH);
  assert.deepEqual(res.coupons.map((c) => c.code).sort(), ['000000777', '012345678']);
  assert.equal(res.total, 2);

  const { order } = await integration.importSaleFromCoupon(morsis, { couponCode: '000000777', branchId: BRANCH });
  await integration.completeSale(morsis, config, order, { payments: cash(order.totalCents) });
  res = await integration.listPendingCoupons(morsis, BRANCH);
  assert.deepEqual(res.coupons.map((c) => c.code), ['012345678']);
});
