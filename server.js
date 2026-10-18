// Servidor de la demo: simula el backend de un POS externo integrado con Morsis.
//
// - Sirve la interfaz web (carpeta public/).
// - Expone una API propia (/api/...) que usa la UI. Esa API es "tu sistema": guarda la venta
//   y habla con Morsis a través de src/integration.js. La API key NUNCA llega al navegador.
//
// Arranque: `npm start` → http://localhost:3000

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import { MorsisClient, MorsisApiError } from './src/morsis-client.js';
import { MockMorsis } from './src/mock-morsis.js';
import * as integration from './src/integration.js';

const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');

// Cada request a /api junta acá las llamadas que hizo a Morsis, para mostrarlas en pantalla.
const callLog = new AsyncLocalStorage();
const onCall = (call) => callLog.getStore()?.push({ ...call, at: new Date().toISOString() });

// El cliente activo: el real si hay API key, o el simulado. Se puede cambiar en caliente desde la UI
// ("Conectar con API key"), útil para probar sin reiniciar. La key pegada queda solo en memoria.
let morsis = createClient();

function createClient() {
  return config.mode === 'real'
    ? new MorsisClient({ apiKey: config.apiKey, baseUrl: config.baseUrl, onCall })
    : new MockMorsis({ onCall });
}

// "Base de datos" del POS: la última versión conocida de cada pedido importado.
// En tu sistema esto vive en tu base, junto a la venta local.
const sales = new Map();
// Numerador de comprobantes del POS (en la vida real lo da tu facturador / controlador fiscal).
let nextDocumentNumber = 8400;

// ------------------------------------------------------------------ rutas de la API del POS

const routes = [
  ['GET', /^\/api\/config$/, async () => ({
    mode: config.mode,
    baseUrl: config.mode === 'real' ? config.baseUrl : 'simulado en memoria',
    branchId: config.branchId,
    externalDeviceId: config.externalDeviceId,
    actorUserId: config.actorUserId,
    actorName: config.actorName,
    canConnect: true,
    invoice: config.invoice,
  })],

  // Conectar con una API key pegada en la pantalla. Se valida leyendo las sucursales.
  ['POST', /^\/api\/session\/connect$/, async ({ body }) => {
    const apiKey = String(body.apiKey ?? '').trim();
    validateOperator(body);
    if (!apiKey) throw Object.assign(new Error('Pegá una API key'), { status: 400, code: 'VALIDATION_ERROR' });
    const baseUrl = ALLOWED_BASE_URLS.includes(body.baseUrl) ? body.baseUrl : config.baseUrl;
    const candidate = new MorsisClient({ apiKey, baseUrl, onCall });
    // Si la key no sirve, falla acá y no cambia nada.
    const branches = await candidate.listBranches().catch((err) => {
      if (err instanceof MorsisApiError) throw err;
      throw Object.assign(new Error(`No se pudo conectar con ${baseUrl}: ${err.cause?.code ?? err.message}`), { status: 502, code: 'NETWORK_ERROR' });
    });
    Object.assign(config, { mode: 'real', apiKey, baseUrl });
    applyOperator(body);
    morsis = candidate;
    sales.clear();
    return { ok: true, branches };
  }],

  // Cambiar el operador (actorUserId) o la caja sin reconectar.
  ['POST', /^\/api\/session\/operator$/, async ({ body }) => {
    validateOperator(body, { required: true });
    applyOperator(body);
    return { actorUserId: config.actorUserId, actorName: config.actorName, externalDeviceId: config.externalDeviceId };
  }],

  ['POST', /^\/api\/session\/disconnect$/, async () => {
    Object.assign(config, { mode: 'mock', apiKey: '' });
    morsis = createClient();
    sales.clear();
    return { ok: true };
  }],

  ['GET', /^\/api\/branches$/, async () => ({ branches: await morsis.listBranches() })],

  // Cajeros para elegir el actorUserId. Si la key no tiene `team:read`, la UI ofrece cargarlo a mano.
  ['GET', /^\/api\/team-members$/, async ({ query }) => {
    try {
      return { available: true, members: await integration.listCashiers(morsis, query.get('branchId') || config.branchId) };
    } catch (err) {
      if (err instanceof MorsisApiError && (err.status === 403 || err.status === 404)) {
        return {
          available: false,
          members: [],
          reason: 'La API key no puede leer el equipo (le falta el permiso team:read). Pedile al comercio que lo agregue, o ingresá el ID de usuario a mano.',
        };
      }
      throw err;
    }
  }],

  // Cupones impagos de la sucursal, para elegirlos de una lista sin entrar a Morsis.
  ['GET', /^\/api\/pending-coupons$/, async ({ query }) => {
    const branchId = query.get('branchId') || config.branchId;
    if (!branchId) return { available: false, coupons: [], reason: 'Elegí una sucursal.' };
    try {
      return { available: true, ...(await integration.listPendingCoupons(morsis, branchId)) };
    } catch (err) {
      if (err instanceof MorsisApiError && err.status === 403) {
        return { available: false, coupons: [], reason: 'La API key no puede listar pedidos de esta sucursal (revisá orders:read y el acceso a la sucursal).' };
      }
      throw err;
    }
  }],

  ['GET', /^\/api\/payment-methods$/, async () => ({ methods: await morsis.listPaymentMethods() })],

  // Paso 1: escanear cupón → importar el pedido como venta del POS.
  ['POST', /^\/api\/sales\/import$/, async ({ body }) => {
    const { order, sale } = await integration.importSaleFromCoupon(morsis, {
      couponCode: body.couponCode,
      branchId: body.branchId || config.branchId,
    });
    sales.set(order.id, order);
    return { order, sale };
  }],

  // Releer el pedido desde Morsis (por ejemplo, tras un conflicto de versión).
  ['GET', /^\/api\/sales\/([\w-]+)$/, async ({ params: [id] }) => {
    const order = await morsis.getOrder(id);
    sales.set(id, order);
    return { order, sale: integration.orderToSale(order) };
  }],

  // Paso 2: editar líneas.
  ['POST', /^\/api\/sales\/([\w-]+)\/remove-line$/, ({ params: [id], body }) =>
    withOrder(id, (order) => integration.removeLine(morsis, config, order, body.lineItemId))],

  ['POST', /^\/api\/sales\/([\w-]+)\/set-quantity$/, ({ params: [id], body }) =>
    withOrder(id, (order) => integration.setLineQuantity(morsis, config, order, body.lineItemId, Number(body.quantity)))],

  // Paso 3: cobrar y facturar en el POS, e informarlo a Morsis.
  ['POST', /^\/api\/sales\/([\w-]+)\/complete$/, ({ params: [id], body }) =>
    withOrder(id, (order) =>
      integration.completeSale(morsis, config, order, {
        payments: body.payments,
        invoice: { number: nextDocumentNumber++, ...(body.invoice ?? {}) },
      }),
    )],

  // Paso 4: devolución parcial o anulación de una venta cobrada.
  ['POST', /^\/api\/sales\/([\w-]+)\/refund$/, ({ params: [id], body }) =>
    withOrder(id, (order) =>
      integration.refundSale(morsis, config, order, {
        payments: body.payments,
        items: body.items,
        reason: body.reason,
        creditNote: { number: nextDocumentNumber++ },
      }),
    )],

  ['POST', /^\/api\/sales\/([\w-]+)\/cancel$/, ({ params: [id], body }) =>
    withOrder(id, (order) =>
      integration.cancelSale(morsis, config, order, { reason: body.reason, creditNote: { number: nextDocumentNumber++ } }),
    )],

  // Solo modo demo.
  ['POST', /^\/api\/mock\/reset$/, async () => {
    assertMock();
    morsis.reset();
    sales.clear();
    return { ok: true };
  }],

  ['POST', /^\/api\/mock\/sales\/([\w-]+)\/concurrent-edit$/, async ({ params: [id] }) => {
    assertMock();
    morsis.simulateConcurrentEdit(id);
    return { ok: true };
  }],
];

// Ejecuta un comando con la última versión conocida del pedido y guarda la nueva.
// Ante un 409, Morsis no aplicó nada: releemos el pedido para que el cajero vea el estado real.
async function withOrder(orderId, command) {
  assertOperatorConfigured();
  const order = sales.get(orderId) ?? (await morsis.getOrder(orderId));
  try {
    const updated = await command(order);
    sales.set(orderId, updated);
    return { order: updated, sale: integration.orderToSale(updated) };
  } catch (err) {
    if (err instanceof MorsisApiError && err.status === 409) {
      const fresh = await morsis.getOrder(orderId);
      sales.set(orderId, fresh);
      err.freshOrder = fresh;
    }
    throw err;
  }
}

// Cada comando sobre un pedido se atribuye a un usuario de Morsis (actorUserId, un UUID) y a una
// caja de tu sistema (externalDeviceId). Si falta alguno, avisamos antes de llamar a Morsis con un
// mensaje que diga qué dato falta, en lugar de dejar que la API responda VALIDATION_ERROR.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function operatorError(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

function validateOperator(body, { required = false } = {}) {
  const actor = String(body.actorUserId ?? '').trim();
  if (!actor && required) {
    throw operatorError('MISSING_ACTOR_USER_ID', 'Falta el usuario operador de Morsis (actorUserId).');
  }
  if (actor && !UUID_RE.test(actor)) {
    throw operatorError(
      'INVALID_ACTOR_USER_ID',
      `"${actor}" no es un ID de usuario de Morsis válido. Tiene que ser un UUID, por ejemplo 09af74bb-63d8-47f2-8849-d66fe2b98f37.`,
    );
  }
  if (body.externalDeviceId !== undefined && !String(body.externalDeviceId).trim()) {
    throw operatorError('MISSING_EXTERNAL_DEVICE_ID', 'Falta el ID de la caja (externalDeviceId).');
  }
}

function applyOperator(body) {
  if (body.actorUserId) {
    config.actorUserId = String(body.actorUserId).trim();
    config.actorName = String(body.actorName ?? '').trim();
  }
  if (body.externalDeviceId) config.externalDeviceId = String(body.externalDeviceId).trim();
}

function assertOperatorConfigured() {
  if (morsis instanceof MockMorsis) return; // el Morsis simulado no valida el operador
  if (!UUID_RE.test(config.actorUserId)) {
    throw operatorError(
      config.actorUserId ? 'INVALID_ACTOR_USER_ID' : 'MISSING_ACTOR_USER_ID',
      config.actorUserId
        ? `"${config.actorUserId}" no es un ID de usuario de Morsis válido (tiene que ser un UUID).`
        : 'Falta elegir el cajero (actorUserId). Elegilo para poder modificar o cobrar pedidos.',
    );
  }
}

const ALLOWED_BASE_URLS = ['https://api-staging.morsis.com/v1', 'https://api.morsis.com/v1'];

function assertMock() {
  if (!(morsis instanceof MockMorsis)) throw Object.assign(new Error('Solo disponible en modo demo'), { status: 400 });
}

// ------------------------------------------------------------------ HTTP

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);

  const file = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const content = await readFile(join(PUBLIC_DIR, file));
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404).end('No encontrado');
  }
});

async function handleApi(req, res, url) {
  const calls = [];
  await callLog.run(calls, async () => {
    let status = 200;
    let payload;
    try {
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!route) throw Object.assign(new Error('Ruta inexistente'), { status: 404 });
      const params = url.pathname.match(route[1]).slice(1);
      const body = req.method === 'GET' ? {} : await readJson(req);
      payload = await route[2]({ params, body, query: url.searchParams });
    } catch (err) {
      status = err.status ?? (err.code === 'COUPON_NOT_FOUND' ? 404 : 500);
      payload = {
        error: { code: err.code ?? 'ERROR', message: err.message, details: err.details, requestId: err.requestId },
        ...(err.freshOrder ? { order: err.freshOrder, sale: integration.orderToSale(err.freshOrder) } : {}),
      };
      if (status >= 500 && !(err instanceof MorsisApiError)) console.error(err);
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ...payload, calls }));
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(Object.assign(new Error('JSON inválido'), { status: 400 }));
      }
    });
  });
}

// Por defecto solo escucha en esta máquina: la pantalla permite pegar una API key.
server.listen(config.port, config.host, () => {
  const mode = config.mode === 'real' ? `REAL contra ${config.baseUrl}` : 'DEMO (Morsis simulado, sin API key)';
  console.log(`\n  POS de ejemplo integrado con Morsis\n  Modo: ${mode}\n  Abrí http://localhost:${config.port}\n`);
});
