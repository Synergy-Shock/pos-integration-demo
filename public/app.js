// Interfaz del POS de ejemplo. Habla solo con el backend del POS (/api/...), nunca con Morsis
// directamente: la API key vive en el servidor.

const $ = (sel) => document.querySelector(sel);
const money = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' });
const fmt = (cents) => money.format((cents ?? 0) / 100);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = { config: null, branchId: '', methods: [], order: null, busy: false };

// Explicación en criollo de los errores que puede devolver Morsis.
const ERROR_HELP = {
  COUPON_NOT_FOUND: 'Revisá el código y que la sucursal sea la correcta.',
  ORDER_VERSION_CONFLICT: 'El pedido cambió en Morsis mientras lo tenías abierto. Ya lo releímos: revisalo y volvé a intentar.',
  ORDER_NOT_EDITABLE: 'El pedido ya no está abierto e impago, así que no se puede modificar.',
  ORDER_BUSY: 'Morsis está procesando otra operación sobre este pedido. Probá de nuevo en unos segundos.',
  AMOUNT_MISMATCH: 'Los pagos, la factura y el total esperado tienen que coincidir exactamente con el total del pedido.',
  IDEMPOTENCY_CONFLICT: 'Se reutilizó un Idempotency-Key con otro contenido.',
  ORDER_HAS_REFUNDS: 'La venta ya tiene devoluciones: para revertirla, devolvé el resto en vez de anular.',
  ORDER_NOT_REVERSIBLE: 'Solo se pueden revertir ventas cobradas por tu sistema.',
  CREDIT_NOTE_MISMATCH: 'La nota de crédito no coincide con lo devuelto.',
  UNSUPPORTED_ITEM: 'Esa línea no se puede editar por API (combo, ya enviada a cocina o con ajuste especial).',
  VALIDATION_ERROR: 'Algún dato no tiene el formato esperado.',
  MISSING_ACTOR_USER_ID: 'Es el UUID del usuario de Morsis creado para los cajeros de tu sistema.',
  INVALID_ACTOR_USER_ID: 'Es el UUID del usuario de Morsis creado para los cajeros de tu sistema.',
  NETWORK_ERROR: 'Revisá tu conexión y que la URL del entorno sea la correcta.',
  UNAUTHORIZED: 'La API key es inválida o venció.',
  FORBIDDEN: 'La API key no tiene el permiso o el acceso a la sucursal necesario.',
};

// ------------------------------------------------------------------ comunicación con el backend

async function api(method, path, body, label) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (json.calls?.length) addLog(label, json.calls);
  if (!res.ok) {
    const err = new Error(json.error?.message || 'Error');
    Object.assign(err, json.error, { payload: json });
    throw err;
  }
  return json;
}

// Nombres legibles para los campos que Morsis informa en error.details[].path.
const FIELD_LABELS = {
  actorUserId: 'el usuario operador de Morsis (actorUserId)',
  externalDeviceId: 'el ID de la caja (externalDeviceId)',
  expectedVersion: 'la versión del pedido',
  branchId: 'la sucursal',
  paymentCouponCode: 'el código del cupón',
};

function friendlyError(err) {
  // Faltan datos del operador: se resuelve cargándolos, no es un error técnico.
  if (err.code === 'MISSING_ACTOR_USER_ID' || err.code === 'INVALID_ACTOR_USER_ID') {
    return { title: 'Falta configurar el operador', message: err.message };
  }
  if (err.code === 'VALIDATION_ERROR' && err.details?.length) {
    const lines = err.details.map((d) => {
      const field = String(d.path ?? '').split('.')[0];
      const label = FIELD_LABELS[field] ?? `el campo ${d.path}`;
      return /required/i.test(d.message) ? `Falta ${label}.` : `${label[0].toUpperCase()}${label.slice(1)} no tiene un formato válido (${d.message}).`;
    });
    return { title: 'Datos inválidos', message: lines.join(' ') };
  }
  return { title: err.code ?? 'Error', message: err.message };
}

function showError(err) {
  const fieldsWithOperator = (err.details ?? []).some((d) => /^actorUserId/.test(d.path ?? ''));
  if (['MISSING_ACTOR_USER_ID', 'INVALID_ACTOR_USER_ID'].includes(err.code) || fieldsWithOperator) {
    openOperatorDialog(friendlyError(err).message);
    return;
  }
  const { title, message } = friendlyError(err);
  const help = ERROR_HELP[err.code] ?? '';
  toast('error', title, `${esc(message)}${help ? `<br>${esc(help)}` : ''}${err.requestId ? `<br><code>X-Request-Id ${esc(err.requestId)}</code>` : ''}`);
  // Ante un 409 el backend nos manda el pedido releído: lo mostramos.
  if (err.payload?.order) setOrder(err.payload.order, { flash: true });
}

function toast(kind, title, html = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<b>${esc(title)}</b>${html}`;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 4500);
}

// Ejecuta una acción mostrando que se está aplicando en Morsis: barra de progreso arriba,
// un aviso en la venta, la línea o el botón tocado con su spinner, y el resto de los controles
// bloqueados hasta que llega la respuesta (así no se mandan dos cambios con la misma versión).
async function busy(fn, { label = 'Aplicando en Morsis…', row, button } = {}) {
  if (state.busy) return;
  state.busy = true;
  document.body.classList.add('is-busy');
  $('#sale').classList.add('applying');
  $('#sale-progress').textContent = label;
  row?.classList.add('pending');
  button?.classList.add('loading');
  try {
    return await fn();
  } catch (err) {
    showError(err);
  } finally {
    state.busy = false;
    document.body.classList.remove('is-busy');
    $('#sale').classList.remove('applying');
    row?.classList.remove('pending');
    button?.classList.remove('loading');
  }
}

// ------------------------------------------------------------------ arranque

async function init() {
  const { calls, ...config } = await api('GET', '/api/config', null, 'Configuración');
  state.config = config;
  state.branchId = config.branchId;

  const badge = $('#mode-badge');
  badge.textContent = config.mode === 'mock' ? 'MODO DEMO · Morsis simulado' : `MODO REAL · ${config.baseUrl}`;
  badge.className = `badge ${config.mode}`;
  renderDeviceLabel();
  const connectBtn = $('#connect-btn');
  connectBtn.textContent = config.mode === 'real' ? 'Desconectar' : 'Conectar con API key';
  connectBtn.addEventListener('click', () => (state.config.mode === 'real' ? disconnect() : openConnectDialog()));

  $('#pending-coupons').addEventListener('click', (e) => {
    const c = e.target.closest('[data-coupon]')?.dataset.coupon;
    if (!c || state.busy) return;
    $('#coupon-input').value = c;
    renderBarcode(c);
    scan();
  });
  $('#pending-refresh').addEventListener('click', () => loadPendingCoupons());

  try {
    const { branches } = await api('GET', '/api/branches', null, 'Cargar sucursales');
    const select = $('#branch-select');
    select.innerHTML = branches.map((b) => `<option value="${b.id}">${esc(b.displayName || b.name)}</option>`).join('');
    if (state.branchId && branches.some((b) => b.id === state.branchId)) select.value = state.branchId;
    state.branchId = select.value;
    select.addEventListener('change', () => {
      state.branchId = select.value;
      loadPendingCoupons();
    });
  } catch (err) {
    showError(err);
  }

  try {
    state.methods = (await api('GET', '/api/payment-methods', null, 'Cargar métodos de cobro')).methods;
  } catch (err) {
    showError(err);
  }

  renderBarcode('');
  renderStepper();
  loadPendingCoupons();
  // Recién conectado en modo real y sin cajero elegido: lo pedimos de entrada.
  if (config.mode === 'real' && !config.actorUserId) openOperatorDialog();
  $('#coupon-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '');
    renderBarcode(e.target.value);
  });
  $('#scan-form').addEventListener('submit', (e) => {
    e.preventDefault();
    scan();
  });
  $('#clear-log').addEventListener('click', () => ($('#log-list').innerHTML = ''));
  $('#coupon-input').focus();
}

// ------------------------------------------------------------------ paso 1 y 2: cupón → venta

async function scan() {
  const couponCode = $('#coupon-input').value.trim();
  if (!couponCode) return $('#coupon-input').focus();
  if (!state.branchId) return toast('error', 'Elegí una sucursal');

  const coupon = $('.coupon');
  coupon.classList.add('scanning');
  showSaleSkeleton();
  await busy(async () => {
    try {
      // Pequeña pausa para que se vea la animación del escaneo.
      const [res] = await Promise.all([
        api('POST', '/api/sales/import', { couponCode, branchId: state.branchId }, `Escanear cupón ${couponCode}`),
        new Promise((r) => setTimeout(r, 650)),
      ]);
      setOrder(res.order, { animateIn: true });
      toast('success', `Pedido #${res.order.orderNumber ?? ''} importado`, `${res.order.items.length} productos cargados en la venta.`);
    } catch (err) {
      $('#sale').classList.add('hidden');
      throw err;
    } finally {
      coupon.classList.remove('scanning');
    }
  });
}

// Lista de cupones impagos de la sucursal (GET /orders con filtros). Se recarga al cambiar de
// sucursal, al tocar "Actualizar" y después de cada cambio de estado de una venta.
async function loadPendingCoupons() {
  const list = $('#pending-coupons');
  if (!state.branchId) return (list.innerHTML = '<li class="muted small">Elegí una sucursal.</li>');
  list.classList.add('loading');
  if (!list.children.length) list.innerHTML = [1, 2, 3].map(() => '<li><div class="skeleton"></div></li>').join('');
  try {
    const res = await api('GET', `/api/pending-coupons?branchId=${encodeURIComponent(state.branchId)}`, null, 'Listar cupones pendientes');
    if (!res.available) {
      list.innerHTML = `<li class="muted small">${esc(res.reason)}</li>`;
    } else if (!res.coupons.length) {
      list.innerHTML = '<li class="muted small">No hay cupones pendientes en esta sucursal.</li>';
    } else {
      list.innerHTML =
        res.coupons
          .map(
            (c) => `<li><button type="button" class="pending-item${c.code === state.order?.paymentCoupon?.code ? ' current' : ''}" data-coupon="${esc(c.code)}">
              <code>${esc(c.code)}</code>
              <span>Pedido #${esc(c.orderNumber ?? '—')}</span>
              <span class="muted small">${esc(new Date(c.createdAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }))}</span>
              <strong>${fmt(c.totalCents)}</strong>
            </button></li>`,
          )
          .join('') +
        (res.hasMore ? `<li class="muted small">Se muestran ${res.coupons.length} de ${res.total}. Escaneá el cupón si no está en la lista.</li>` : '');
    }
  } catch (err) {
    list.innerHTML = '<li class="muted small">No se pudo traer la lista. Podés escanear o tipear el cupón.</li>';
    showError(err);
  } finally {
    list.classList.remove('loading');
  }
}

function showSaleSkeleton() {
  const sale = $('#sale');
  sale.classList.remove('hidden');
  $('#sale-title').textContent = 'Buscando el pedido en Morsis…';
  $('#sale-sub').textContent = '';
  $('#status-badges').innerHTML = '';
  $('#customer').innerHTML = '<div class="skeleton" style="width:60%"></div>';
  $('#ticket-lines').innerHTML = [1, 2, 3].map(() => `<tr><td colspan="5"><div class="skeleton"></div></td></tr>`).join('');
  $('#totals').innerHTML = '';
  $('#docs').innerHTML = '';
  $('#actions').innerHTML = '';
}

function setOrder(order, opts = {}) {
  const prev = state.order;
  state.order = order;
  // Un cupón entra o sale de la lista de pendientes cuando cambia de pedido o de estado.
  if (!prev || prev.id !== order.id || prev.paymentStatus !== order.paymentStatus || prev.preparationStatus !== order.preparationStatus) {
    loadPendingCoupons();
  }
  renderSale(order, opts);
  renderStepper();
  $('#raw-json').textContent = JSON.stringify(order, null, 2);
}

// ------------------------------------------------------------------ render de la venta

function isEditable(order) {
  return order.paymentStatus === 'unpaid' && !order.cancelledAt;
}

const STATUS_LABELS = {
  paymentStatus: { unpaid: ['Impago', 'warn'], paid: ['Pagado', 'ok'], refunded: ['Reembolsado', 'danger'] },
  preparationStatus: {
    pending: ['Pendiente', 'info'], confirmed: ['Confirmado', 'info'], preparing: ['En preparación', 'info'],
    ready: ['Listo', 'ok'], completed: ['Completado', 'ok'], cancelled: ['Cancelado', 'danger'], in_table: ['En mesa', 'info'],
  },
  serviceMode: { dine_in: 'Salón', takeaway: 'Para llevar', delivery: 'Delivery' },
};

function badge([label, kind] = ['?', '']) {
  return `<span class="badge ${kind}">${esc(label)}</span>`;
}

function renderSale(order, { animateIn = false, flash = false } = {}) {
  $('#sale').classList.remove('hidden');
  const editable = isEditable(order);

  $('#sale-title').textContent = `Pedido #${order.orderNumber ?? '—'}`;
  $('#sale-sub').innerHTML =
    `Cupón <code>${esc(order.paymentCoupon?.code)}</code> · ${esc(STATUS_LABELS.serviceMode[order.serviceMode] ?? order.serviceMode ?? '')} · ` +
    `creado ${new Date(order.createdAt).toLocaleString('es-AR')} · versión <code title="${esc(order.version)}">${esc(order.version.slice(-8))}</code>`;

  $('#status-badges').innerHTML =
    `<span class="muted small">Pago</span>${badge(STATUS_LABELS.paymentStatus[order.paymentStatus] ?? [order.paymentStatus, ''])}` +
    `<span class="muted small">Preparación</span>${badge(STATUS_LABELS.preparationStatus[order.preparationStatus] ?? [order.preparationStatus, ''])}`;

  const c = order.customer;
  $('#customer').innerHTML = c
    ? `<span>Cliente: <b>${esc(c.name ?? 'Sin nombre')}</b></span>` +
      (c.phone ? `<span>${esc(c.phone)}</span>` : '') +
      (c.email ? `<span>${esc(c.email)}</span>` : '') +
      (c.taxId ? `<span>CUIT/DNI: <b>${esc(c.taxId)}</b></span>` : '') +
      (c.ivaCondition ? `<span>IVA: ${esc(c.ivaCondition.replace(/_/g, ' '))}</span>` : '')
    : '<span class="muted">Pedido sin cliente identificado</span>';

  const tbody = $('#ticket-lines');
  if (!order.items.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">El pedido no tiene productos.</td></tr>`;
  } else {
    tbody.innerHTML = order.items
      .map((item, i) => {
        const canEdit = editable && item.lineItemId;
        const opts = item.options.map((o) => `${o.optionGroupName ? `${esc(o.optionGroupName)}: ` : ''}${esc(o.name)}${o.priceCents && o.modifierType !== 'none' ? ` (${o.modifierType === 'decrease' ? '−' : '+'}${fmt(o.priceCents)})` : ''}`).join(' · ');
        return `<tr data-line="${item.lineItemId ?? ''}" class="${animateIn ? 'enter' : ''}" style="${animateIn ? `animation-delay:${i * 110}ms` : ''}">
          <td>
            <div class="name">${esc(item.name)}</div>
            ${opts ? `<div class="opts">${opts}</div>` : ''}
            ${item.notes ? `<div class="notes">✎ ${esc(item.notes)}</div>` : ''}
            <div class="sku">${esc(item.sku ?? '')}${item.taxRate != null ? ` · IVA ${item.taxRate}%` : ''}</div>
          </td>
          <td class="num">
            <span class="qty">
              ${canEdit ? `<button class="icon-btn" data-act="minus" title="Restar uno">−</button>` : ''}
              <b>${item.quantity}</b>
              ${canEdit ? `<button class="icon-btn" data-act="plus" title="Sumar uno">+</button>` : ''}
            </span>
          </td>
          <td class="num">${fmt(item.priceCents)}</td>
          <td class="num"><b>${fmt(item.totalCents)}</b></td>
          <td class="num">${canEdit ? `<button class="icon-btn remove" data-act="remove" title="Quitar producto">✕</button>` : ''}</td>
        </tr>`;
      })
      .join('');
  }
  if (flash) tbody.querySelectorAll('tr').forEach((tr) => tr.classList.add('flash'));

  $('#totals').innerHTML =
    `<div class="row"><span>Subtotal</span><span>${fmt(order.subtotalCents)}</span></div>` +
    (order.discountCents ? `<div class="row"><span>Descuento</span><span>−${fmt(order.discountCents)}</span></div>` : '') +
    (order.deliveryFeeCents ? `<div class="row"><span>Envío</span><span>${fmt(order.deliveryFeeCents)}</span></div>` : '') +
    order.taxBreakdown.map((t) => `<div class="row"><span>IVA ${t.rate}% incluido</span><span>${fmt(t.taxCents)}</span></div>`).join('') +
    `<div class="row total"><span>Total</span><span>${fmt(order.totalCents)}</span></div>`;

  renderDocs(order);
  renderActions(order);
}

function renderDocs(order) {
  const parts = [];
  for (const p of order.payments) {
    const refunded = order.refunds.filter((r) => r.paymentId === p.id).reduce((s, r) => s + r.amountCents, 0);
    const method = state.methods.find((m) => m.id === p.methodId)?.name ?? p.methodId;
    parts.push(`<div class="doc"><span><span class="kind">💳 Pago</span> · ${esc(method)}${p.card?.lastFour ? ` ···· ${esc(p.card.lastFour)}` : ''}${p.card?.installments > 1 ? ` · ${p.card.installments} cuotas` : ''} · ref ${esc(p.reference)}</span>
      <span>${fmt(p.amountCents)}${refunded ? ` <span class="badge danger">−${fmt(refunded)} devuelto</span>` : ''} <span class="badge">${esc(p.collectedBy)}</span></span></div>`);
  }
  for (const inv of order.invoices) {
    const isNc = inv.documentType === 'credit_note';
    const pv = String(inv.pointOfSale ?? 0).padStart(5, '0');
    const nro = String(inv.number ?? 0).padStart(8, '0');
    parts.push(`<div class="doc"><span><span class="kind">${isNc ? '↩︎ Nota de crédito' : '🧾 Factura'}</span> tipo ${inv.typeCode} · ${pv}-${nro} · ${esc(inv.issuedOn)} · CUIT ${esc(inv.issuerTaxId)}</span><span>${isNc ? '−' : ''}${fmt(inv.totalCents)}</span></div>`);
  }
  $('#docs').innerHTML = parts.join('');
}

function renderActions(order) {
  const el = $('#actions');
  const mock = state.config.mode === 'mock';
  const cancelled = Boolean(order.cancelledAt);
  const paid = order.paymentStatus === 'paid';
  const refunded = order.paymentStatus === 'refunded';

  if (isEditable(order)) {
    el.innerHTML =
      `<button class="btn success big" data-act="pay" ${order.items.length ? '' : 'disabled'}>Cobrar ${fmt(order.totalCents)}</button>` +
      `<button class="btn" data-act="reload" title="GET /orders/{id}">Releer de Morsis</button>` +
      (mock ? `<button class="btn ghost" data-act="concurrent" title="Cambia la versión del pedido en el Morsis simulado">Simular cambio en Morsis</button>` : '') +
      `<span class="spacer"></span><button class="btn ghost" data-act="discard" title="Solo limpia la pantalla del POS. En Morsis el pedido sigue abierto.">Descartar venta</button>`;
  } else {
    let banner = '';
    if (cancelled) banner = `<div class="success-banner cancelled"><span class="big-icon">⊘</span>Venta anulada. Morsis canceló el pedido y revirtió stock y contabilidad.</div>`;
    else if (refunded) banner = `<div class="success-banner cancelled"><span class="big-icon">↩︎</span>Venta reembolsada por completo.</div>`;
    else if (paid) banner = `<div class="success-banner"><span class="big-icon">✓</span>Cobrado y facturado. Morsis registró el pago externo y la factura.</div>`;
    el.innerHTML =
      (paid && !cancelled
        ? `<button class="btn" data-act="refund">Devolución parcial</button><button class="btn danger" data-act="cancel">Anular venta</button>`
        : '') +
      `<button class="btn" data-act="reload">Releer de Morsis</button><span class="spacer"></span>` +
      `<button class="btn primary" data-act="new">Nueva venta</button>`;
    $('#sale .success-banner')?.remove();
    if (banner) $('#docs').insertAdjacentHTML('afterend', banner);
    return;
  }
  $('#sale .success-banner')?.remove();
}

function renderStepper() {
  const order = state.order;
  let current = 'scan';
  const done = new Set();
  if (order) {
    done.add('scan').add('import');
    current = 'edit';
    if (order.paymentStatus !== 'unpaid') {
      done.add('edit').add('pay');
      current = 'after';
    }
    if (order.cancelledAt || order.refunds.length) done.add('after');
  }
  for (const li of document.querySelectorAll('#stepper li')) {
    const step = li.dataset.step;
    li.classList.toggle('done', done.has(step));
    li.classList.toggle('current', step === current && !done.has(step));
  }
}

function renderBarcode(code) {
  // Barras "decorativas" generadas a partir de los dígitos, para que el cupón se vea real.
  const digits = (code || '000000000').padEnd(9, '0');
  let bars = '<i style="width:2px"></i><i style="width:0;margin-right:2px"></i><i style="width:2px;margin-right:3px"></i>';
  for (const d of digits) {
    const n = Number(d);
    bars += `<i style="width:${1 + (n % 3)}px;margin-right:${1 + ((n + 1) % 3)}px"></i><i style="width:${1 + ((n * 7) % 4)}px;margin-right:${2 + (n % 2)}px"></i>`;
  }
  bars += '<i style="width:2px;margin-right:2px"></i><i style="width:2px"></i>';
  $('#barcode').innerHTML = `<div class="bars">${bars}</div>`;
  let digitsEl = $('.barcode-digits');
  if (!digitsEl) {
    digitsEl = document.createElement('div');
    digitsEl.className = 'barcode-digits';
    $('#barcode').after(digitsEl);
  }
  digitsEl.textContent = code || '— — — — — — — — —';
}

// ------------------------------------------------------------------ paso 3: editar líneas

$('#ticket-lines').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const lineItemId = tr.dataset.line;
  const item = state.order.items.find((i) => i.lineItemId === lineItemId);
  const id = state.order.id;

  const removing = btn.dataset.act === 'remove' || (btn.dataset.act === 'minus' && item.quantity === 1);
  const quantity = item.quantity + (btn.dataset.act === 'plus' ? 1 : -1);
  const label = removing ? `Quitando "${item.name}" en Morsis…` : `Cambiando la cantidad a ${quantity} en Morsis…`;

  busy(async () => {
    if (removing) {
      const res = await api('POST', `/api/sales/${id}/remove-line`, { lineItemId }, `Quitar "${item.name}"`);
      // Confirmado por Morsis: recién ahora animamos la salida de la línea.
      tr.classList.add('leaving');
      await new Promise((r) => setTimeout(r, 300));
      setOrder(res.order);
      toast('info', 'Producto quitado', `${esc(item.name)} se quitó del pedido en Morsis. Nuevo total ${fmt(res.order.totalCents)}.`);
    } else {
      const res = await api('POST', `/api/sales/${id}/set-quantity`, { lineItemId, quantity }, `Cantidad de "${item.name}" → ${quantity}`);
      setOrder(res.order);
      document.querySelector(`tr[data-line="${lineItemId}"]`)?.classList.add('flash');
    }
  }, { label, row: tr, button: btn });
});

// ------------------------------------------------------------------ acciones

$('#actions').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-act]');
  const act = button?.dataset.act;
  if (!act) return;
  const id = state.order?.id;
  if (act === 'pay') return openPayDialog();
  if (act === 'refund') return openRefundDialog();
  if (act === 'cancel') return openCancelDialog();
  if (act === 'reload')
    return busy(async () => {
      const res = await api('GET', `/api/sales/${id}`, null, 'Releer pedido');
      setOrder(res.order, { flash: true });
    }, { label: 'Releyendo el pedido de Morsis…', button });
  if (act === 'concurrent')
    return busy(async () => {
      await api('POST', `/api/mock/sales/${id}/concurrent-edit`, {}, 'Simular cambio en Morsis');
      toast('info', 'Listo', 'Alguien "editó" el pedido en Morsis. El próximo cambio que hagas va a recibir un 409 ORDER_VERSION_CONFLICT.');
    }, { label: 'Simulando un cambio en Morsis…', button });
  if (act === 'discard' || act === 'new') {
    state.order = null;
    $('#sale').classList.add('hidden');
    $('#raw-json').textContent = 'Todavía no hay pedido cargado.';
    $('#coupon-input').value = '';
    renderBarcode('');
    renderStepper();
    $('#coupon-input').focus();
    if (act === 'discard') toast('info', 'Venta descartada', 'Solo se limpió el POS. En Morsis el pedido sigue abierto e impago.');
  }
});

// ------------------------------------------------------------------ paso 4: cobro

const toCents = (v) => Math.round(parseFloat(String(v).replace(/\./g, '').replace(',', '.') || '0') * 100);
const toInput = (cents) => (cents / 100).toFixed(2).replace('.', ',');

function openPayDialog() {
  const order = state.order;
  const dlg = $('#dialog');
  const methodOptions = state.methods.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  const rowHtml = (amount) => `
    <div class="pay-row">
      <div class="grid">
        <label class="field">Medio de cobro<select name="methodId">${methodOptions}</select></label>
        <label class="field">Monto<input name="amount" value="${toInput(amount)}" inputmode="decimal" /></label>
        <label class="field">Referencia / comprobante<input name="reference" value="op-${Math.floor(Math.random() * 1e6)}" /></label>
      </div>
      <div class="grid card-fields hidden">
        <label class="field">Marca<input name="cardBrand" value="visa" /></label>
        <label class="field">Últimos 4<input name="cardLastFour" value="1234" maxlength="4" inputmode="numeric" /></label>
        <label class="field installments">Cuotas<input name="installments" value="1" type="number" min="1" max="99" /></label>
      </div>
    </div>`;

  dlg.innerHTML = `<form class="dlg" method="dialog">
    <h3>Cobrar pedido #${esc(order.orderNumber)}</h3>
    <div class="note">Tu sistema cobra y emite su propia factura. Después se informa a Morsis con
      <code>POST /orders/{id}/external-completion</code>: pagos, factura y total tienen que sumar exactamente ${fmt(order.totalCents)}.</div>
    <div id="pay-rows">${rowHtml(order.totalCents)}</div>
    <button type="button" class="btn ghost small" id="add-pay">+ Agregar otro medio de pago</button>
    <div class="remaining" id="remaining"></div>
    <div class="buttons">
      <button type="button" class="btn ghost" value="cancel" id="dlg-close">Cancelar</button>
      <button type="submit" class="btn success" id="confirm-pay">Cobrar y facturar</button>
    </div>
  </form>`;

  const rows = dlg.querySelector('#pay-rows');
  const update = () => {
    let sum = 0;
    for (const row of rows.querySelectorAll('.pay-row')) {
      sum += toCents(row.querySelector('[name=amount]').value);
      const method = row.querySelector('[name=methodId]').value;
      const isCard = method === 'debit_card' || method === 'credit_card';
      row.querySelector('.card-fields').classList.toggle('hidden', !isCard);
      row.querySelector('.installments').classList.toggle('hidden', method !== 'credit_card');
    }
    const diff = order.totalCents - sum;
    const rem = dlg.querySelector('#remaining');
    rem.className = `remaining ${diff === 0 ? 'ok' : 'bad'}`;
    rem.innerHTML = diff === 0 ? `<span>Total cubierto</span><span>${fmt(sum)}</span>` : `<span>${diff > 0 ? 'Falta cobrar' : 'Sobra'}</span><span>${fmt(Math.abs(diff))}</span>`;
    dlg.querySelector('#confirm-pay').disabled = diff !== 0;
  };
  rows.addEventListener('input', update);
  rows.addEventListener('change', update);
  dlg.querySelector('#add-pay').addEventListener('click', () => {
    const sum = [...rows.querySelectorAll('[name=amount]')].reduce((s, i) => s + toCents(i.value), 0);
    rows.insertAdjacentHTML('beforeend', rowHtml(Math.max(order.totalCents - sum, 0)));
    update();
  });
  dlg.querySelector('#dlg-close').addEventListener('click', () => dlg.close());
  dlg.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const payments = [...rows.querySelectorAll('.pay-row')].map((row) => {
      const get = (n) => row.querySelector(`[name=${n}]`).value.trim();
      return {
        methodId: get('methodId'),
        amountCents: toCents(get('amount')),
        reference: get('reference'),
        cardBrand: get('cardBrand'),
        cardLastFour: get('cardLastFour'),
        installments: Number(get('installments')),
      };
    });
    dlg.close();
    busy(async () => {
      const res = await api('POST', `/api/sales/${order.id}/complete`, { payments }, `Cobrar ${fmt(order.totalCents)}`);
      setOrder(res.order);
      toast('success', '¡Venta cobrada!', 'Morsis registró el cobro externo y la factura.');
    }, { label: 'Registrando el cobro y la factura en Morsis…', button: $('#actions [data-act=pay]') });
  });
  update();
  dlg.showModal();
}

// ------------------------------------------------------------------ paso 5: devolución y anulación

function openRefundDialog() {
  const order = state.order;
  const dlg = $('#dialog');
  const payments = order.payments.filter((p) => p.collectedBy === 'external');
  const refundable = (p) => p.amountCents - order.refunds.filter((r) => r.paymentId === p.id).reduce((s, r) => s + r.amountCents, 0);

  dlg.innerHTML = `<form class="dlg">
    <h3>Devolución parcial</h3>
    <div class="note">Tu sistema devuelve la plata y emite la nota de crédito; Morsis solo lo registra con
      <code>POST /orders/{id}/external-refunds</code>. Si marcás productos devueltos, el monto se calcula con sus precios de venta.</div>
    <div class="field">Productos devueltos (opcional)</div>
    ${order.items
      .filter((i) => i.lineItemId)
      .map((i) => `<label class="grid" style="align-items:center"><span>${esc(i.name)} <span class="muted small">(${i.quantity} × ${fmt(i.totalCents / i.quantity)})</span></span>
        <input type="number" min="0" max="${i.quantity}" value="0" data-item="${i.lineItemId}" data-unit="${i.totalCents / i.quantity}" /></label>`)
      .join('')}
    <div class="field">Monto devuelto por cada pago</div>
    ${payments
      .map((p) => `<label class="grid" style="align-items:center"><span>${esc(state.methods.find((m) => m.id === p.methodId)?.name ?? p.methodId)} <span class="muted small">(disponible ${fmt(refundable(p))})</span></span>
        <input data-payment="${p.id}" data-max="${refundable(p)}" value="0,00" inputmode="decimal" /></label>`)
      .join('')}
    <label class="field">Motivo<input name="reason" value="Producto devuelto" /></label>
    <div class="remaining" id="remaining"></div>
    <div class="buttons">
      <button type="button" class="btn ghost" id="dlg-close">Cancelar</button>
      <button type="submit" class="btn primary" id="confirm">Registrar devolución</button>
    </div>
  </form>`;

  const payInputs = [...dlg.querySelectorAll('[data-payment]')];
  const itemInputs = [...dlg.querySelectorAll('[data-item]')];
  const update = (fromItems) => {
    if (fromItems && payInputs[0]) {
      // Al marcar productos, cargamos su valor en el primer pago (podés repartirlo a mano).
      const itemsTotal = itemInputs.reduce((s, i) => s + Math.round(Number(i.value) * Number(i.dataset.unit)), 0);
      payInputs[0].value = toInput(Math.min(itemsTotal, Number(payInputs[0].dataset.max)));
    }
    const total = payInputs.reduce((s, i) => s + toCents(i.value), 0);
    const over = payInputs.some((i) => toCents(i.value) > Number(i.dataset.max));
    const rem = dlg.querySelector('#remaining');
    rem.className = `remaining ${total > 0 && !over ? 'ok' : 'bad'}`;
    rem.innerHTML = over ? '<span>Un monto supera lo disponible</span><span></span>' : `<span>Nota de crédito por</span><span>${fmt(total)}</span>`;
    dlg.querySelector('#confirm').disabled = total <= 0 || over;
  };
  itemInputs.forEach((i) => i.addEventListener('input', () => update(true)));
  payInputs.forEach((i) => i.addEventListener('input', () => update(false)));
  dlg.querySelector('#dlg-close').addEventListener('click', () => dlg.close());
  dlg.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const body = {
      reason: dlg.querySelector('[name=reason]').value.trim() || undefined,
      payments: payInputs.map((i) => ({ paymentId: i.dataset.payment, amountCents: toCents(i.value) })).filter((p) => p.amountCents > 0),
      items: itemInputs.map((i) => ({ lineItemId: i.dataset.item, quantity: Number(i.value) })).filter((i) => i.quantity > 0),
    };
    dlg.close();
    busy(async () => {
      const res = await api('POST', `/api/sales/${order.id}/refund`, body, 'Devolución parcial');
      setOrder(res.order);
      toast('success', 'Devolución registrada', `Nota de crédito informada a Morsis.`);
    }, { label: 'Registrando la devolución en Morsis…', button: $('#actions [data-act=refund]') });
  });
  update(false);
  dlg.showModal();
}

function openCancelDialog() {
  const order = state.order;
  const dlg = $('#dialog');
  dlg.innerHTML = `<form class="dlg">
    <h3>Anular venta #${esc(order.orderNumber)}</h3>
    <div class="note">Tu sistema devuelve todo y emite una nota de crédito por ${fmt(order.totalCents)}. Morsis cancela el pedido,
      devuelve el stock y revierte la contabilidad (<code>POST /orders/{id}/external-cancellation</code>).
      Si ya hubo devoluciones parciales, hay que devolver el resto en lugar de anular.</div>
    <label class="field">Motivo (obligatorio)<textarea name="reason" rows="2" required>El comprador desistió de la compra</textarea></label>
    <div class="buttons">
      <button type="button" class="btn ghost" id="dlg-close">Volver</button>
      <button type="submit" class="btn danger">Anular venta</button>
    </div>
  </form>`;
  dlg.querySelector('#dlg-close').addEventListener('click', () => dlg.close());
  dlg.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const reason = dlg.querySelector('[name=reason]').value.trim();
    dlg.close();
    busy(async () => {
      const res = await api('POST', `/api/sales/${order.id}/cancel`, { reason }, 'Anular venta');
      setOrder(res.order);
      toast('success', 'Venta anulada', 'Morsis canceló el pedido.');
    }, { label: 'Anulando la venta en Morsis…', button: $('#actions [data-act=cancel]') });
  });
  dlg.showModal();
}

// ------------------------------------------------------------------ operador y caja

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function renderDeviceLabel() {
  // Caja y cajero se pueden cambiar en cualquier momento (en modo demo, Morsis simulado no los valida).
  const { externalDeviceId, actorUserId, actorName, mode } = state.config;
  const el = $('#device-label');
  const operator = actorUserId
    ? `<span title="${esc(actorUserId)}">${esc(actorName || actorUserId.slice(0, 8) + '…')}</span>`
    : mode === 'real' ? '<b class="missing">sin elegir</b>' : 'demo';
  el.innerHTML = `Caja: ${esc(externalDeviceId)} · Cajero: ${operator}
    <button class="btn ghost small" id="operator-btn" type="button">Cambiar</button>`;
  $('#operator-btn').addEventListener('click', () => openOperatorDialog());
}

// Elegir el cajero (actorUserId) y la caja. Los cajeros salen de GET /team/members; si la key no
// tiene el scope team:read, se puede pegar el UUID a mano. Se abre sola si un comando lo necesita.
async function openOperatorDialog(reason = '') {
  const dlg = $('#dialog');
  if (dlg.open) dlg.close();
  dlg.innerHTML = `<form class="dlg" autocomplete="off">
    <h3>Cajero y caja</h3>
    ${reason ? `<div class="note warn-note">${esc(reason)}</div>` : ''}
    <div class="note">Morsis registra qué usuario hizo cada cambio o cobro. Elegí el usuario del equipo de Morsis
      que opera esta caja.</div>
    <label class="field">Cajero
      <input id="member-search" type="search" placeholder="Buscar por nombre o email" />
    </label>
    <div class="member-list" id="member-list"><div class="skeleton"></div><div class="skeleton"></div></div>
    <details id="manual-actor">
      <summary class="small">Ingresar el ID de usuario a mano</summary>
      <label class="field">ID de usuario de Morsis (actorUserId)
        <input name="actorUserId" placeholder="09af74bb-63d8-47f2-8849-d66fe2b98f37" value="${esc(state.config.actorUserId || '')}" />
      </label>
    </details>
    <span class="field-error" id="actor-error"></span>
    <label class="field">ID de tu caja (externalDeviceId)<input name="externalDeviceId" required value="${esc(state.config.externalDeviceId)}" /></label>
    <div class="buttons">
      <button type="button" class="btn ghost" id="dlg-close">Cancelar</button>
      <button type="submit" class="btn primary">Guardar</button>
    </div>
  </form>`;
  const listEl = dlg.querySelector('#member-list');
  const manual = dlg.querySelector('[name=actorUserId]');
  const errorEl = dlg.querySelector('#actor-error');
  let selected = state.config.actorUserId ? { userId: state.config.actorUserId, name: state.config.actorName } : null;
  let members = [];

  const renderMembers = () => {
    const q = dlg.querySelector('#member-search').value.trim().toLowerCase();
    const shown = members.filter((m) => !q || `${m.name ?? ''} ${m.email}`.toLowerCase().includes(q));
    listEl.innerHTML = shown.length
      ? shown.map((m) => `<button type="button" class="member ${selected?.userId === m.userId ? 'selected' : ''}" data-user="${esc(m.userId)}">
          <span class="avatar">${esc((m.name || m.email).trim()[0]?.toUpperCase() ?? '?')}</span>
          <span class="who"><b>${esc(m.name || m.email)}</b><small>${esc(m.email)}</small></span>
          <span class="badge">${esc(m.jobTitle || m.role)}</span>
        </button>`).join('')
      : `<div class="muted small">${members.length ? 'Ningún cajero coincide con la búsqueda.' : 'No hay usuarios del equipo con acceso a esta sucursal.'}</div>`;
  };
  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-user]');
    if (!btn) return;
    const m = members.find((x) => x.userId === btn.dataset.user);
    selected = { userId: m.userId, name: m.name || m.email };
    manual.value = m.userId;
    errorEl.textContent = '';
    renderMembers();
  });
  manual.addEventListener('input', () => {
    selected = null;
    errorEl.textContent = '';
    renderMembers();
  });
  dlg.querySelector('#member-search').addEventListener('input', renderMembers);
  dlg.querySelector('#dlg-close').addEventListener('click', () => dlg.close());
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const actorUserId = (selected?.userId ?? manual.value).trim();
    if (!UUID_RE.test(actorUserId)) {
      errorEl.textContent = actorUserId
        ? 'El ID de usuario tiene que ser un UUID, por ejemplo 09af74bb-63d8-47f2-8849-d66fe2b98f37.'
        : 'Elegí un cajero de la lista.';
      return;
    }
    const body = {
      actorUserId,
      actorName: selected?.userId === actorUserId ? selected.name ?? '' : '',
      externalDeviceId: dlg.querySelector('[name=externalDeviceId]').value.trim(),
    };
    try {
      const res = await api('POST', '/api/session/operator', body, 'Elegir cajero');
      Object.assign(state.config, res);
      renderDeviceLabel();
      dlg.close();
      toast('success', 'Cajero guardado', `${esc(res.actorName || res.actorUserId)} · caja ${esc(res.externalDeviceId)}.`);
    } catch (err) {
      errorEl.textContent = friendlyError(err).message;
    }
  });
  dlg.showModal();

  try {
    const res = await api('GET', `/api/team-members?branchId=${encodeURIComponent(state.branchId)}`, null, 'Cargar cajeros');
    members = res.members;
    if (!res.available) {
      listEl.innerHTML = `<div class="note small">${esc(res.reason)}</div>`;
      dlg.querySelector('#manual-actor').open = true;
      return;
    }
    renderMembers();
    dlg.querySelector('#member-search').focus();
  } catch (err) {
    listEl.innerHTML = `<div class="note small">No se pudo cargar el equipo: ${esc(friendlyError(err).message)}</div>`;
    dlg.querySelector('#manual-actor').open = true;
  }
}

// ------------------------------------------------------------------ conectar con una API key

function openConnectDialog() {
  const dlg = $('#dialog');
  if (!state.config.canConnect) {
    // Versión publicada online: el navegador no puede llamar a la API de Morsis desde esta página.
    dlg.innerHTML = `<form class="dlg">
      <h3>Probar con tu API key</h3>
      <div class="note">Esta versión online corre entera en el navegador y no puede llamar a la API de Morsis:
        la página solo puede hablar con su propio servidor, y la API key nunca debería estar en un navegador.</div>
      <p>Para probar en vivo, corré la app en tu máquina. Ahí este mismo botón te deja pegar la key:</p>
      <pre class="note" style="margin:0">npm start\n# abrí http://localhost:3000 y tocá "Conectar con API key"</pre>
      <div class="buttons"><button type="button" class="btn primary" id="dlg-close">Entendido</button></div>
    </form>`;
    dlg.querySelector('#dlg-close').addEventListener('click', () => dlg.close());
    return dlg.showModal();
  }
  dlg.innerHTML = `<form class="dlg" autocomplete="off">
    <h3>Conectar con Morsis</h3>
    <div class="note">La key va solo al servidor de esta app (tu máquina) y queda en memoria hasta que lo cierres.
      No se guarda en ningún archivo ni en el navegador.</div>
    <label class="field">Entorno
      <select name="baseUrl">
        <option value="https://api-staging.morsis.com/v1">Staging · api-staging.morsis.com</option>
        <option value="https://api.morsis.com/v1">Producción · api.morsis.com</option>
      </select>
    </label>
    <label class="field">API key<input name="apiKey" type="password" placeholder="mk_live_…" required /></label>
    <label class="field">ID de tu caja (externalDeviceId)<input name="externalDeviceId" value="${esc(state.config.externalDeviceId)}" /></label>
    <div class="buttons">
      <button type="button" class="btn ghost" id="dlg-close">Cancelar</button>
      <button type="submit" class="btn primary" id="connect-submit">Conectar</button>
    </div>
  </form>`;
  dlg.querySelector('#dlg-close').addEventListener('click', () => dlg.close());
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const btn = dlg.querySelector('#connect-submit');
    btn.disabled = true;
    btn.textContent = 'Probando la key…';
    try {
      const res = await api('POST', '/api/session/connect', Object.fromEntries(form), 'Conectar con API key');
      dlg.close();
      toast('success', 'Conectado a Morsis', `La key funciona: ${res.branches.length} sucursales disponibles. Ahora elegí el cajero.`);
      setTimeout(() => location.reload(), 900);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Conectar';
      showError(err);
    }
  });
  dlg.showModal();
  dlg.querySelector('[name=apiKey]').focus();
}

async function disconnect() {
  await busy(async () => {
    await api('POST', '/api/session/disconnect', {}, 'Desconectar');
    location.reload();
  });
}

// ------------------------------------------------------------------ log de llamadas

function addLog(label, calls) {
  const list = $('#log-list');
  for (const call of [...calls].reverse()) {
    const li = document.createElement('li');
    const s = String(call.status)[0];
    li.innerHTML = `
      <div class="action-label">${esc(label)} · ${new Date(call.at).toLocaleTimeString('es-AR')}${call.mock ? ' · simulado' : ''}</div>
      <div class="log-summary">
        <span class="method ${call.method}">${call.method}</span>
        <span class="path" title="${esc(call.path)}">${esc(call.path)}</span>
        <span class="status s${s}">${call.status}</span>
        <span class="muted small">${call.durationMs} ms</span>
      </div>
      <div class="log-detail">
        ${call.idempotencyKey ? `<h4>Idempotency-Key</h4><code>${esc(call.idempotencyKey)}</code>` : ''}
        ${call.requestId ? `<h4>X-Request-Id</h4><code>${esc(call.requestId)}</code>` : ''}
        ${call.requestBody ? `<h4>Request body</h4><pre>${esc(JSON.stringify(call.requestBody, null, 2))}</pre>` : ''}
        <h4>Response</h4><pre>${esc(JSON.stringify(call.responseBody, null, 2))}</pre>
      </div>`;
    li.querySelector('.log-summary').addEventListener('click', () => li.classList.toggle('open'));
    list.prepend(li);
  }
}

init().catch(showError);
