// nota. — guest bill, real-time sync via Socket.io, MIA payment flow

const state = {
  tableNumber:  null,
  order:        null,
  splitMode:    'items',   // 'items' | 'equal' | 'rest'
  guestCount:   2,
  selected:     new Set(), // item IDs tapped in 'Pozițiile mele' mode
  claimedIds:   [],        // confirmed by server after claim-items event
  tipPct:       0,         // 0 | 10 | 15 | 20
  // Captured at the moment "Continuă" is tapped, before order-update mutates state:
  paymentBase:  0,         // base amount to pay (without tip)
  paymentItems: [],        // item objects for the items-mode summary list
  claiming:     false,     // true while we're mid-claim, suppresses our own order-update
};

let socket;

// ── Utilities ─────────────────────────────────────────────────────────────────

function fmt(n) {
  return Number(n).toLocaleString('ro-RO', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' lei';
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function currentScreen() {
  return document.querySelector('.screen.active')?.id;
}

// ── Amount helpers ────────────────────────────────────────────────────────────

function billTotal() {
  return (state.order?.items ?? []).reduce((s, i) => s + parseFloat(i.price_lei), 0);
}

// The base amount this guest owes (before tip).
function baseAmount() {
  const items = state.order?.items ?? [];
  if (state.splitMode === 'items') {
    return items
      .filter(i => state.selected.has(i.id))
      .reduce((s, i) => s + parseFloat(i.price_lei), 0);
  }
  if (state.splitMode === 'equal') {
    return billTotal() / Math.max(1, state.guestCount);
  }
  if (state.splitMode === 'rest') {
    // Only available items (claimed ones are being handled by someone else).
    return items
      .filter(i => i.status === 'available')
      .reduce((s, i) => s + parseFloat(i.price_lei), 0);
  }
  return 0;
}

function finalAmount() {
  return state.paymentBase * (1 + state.tipPct / 100);
}

// ── Toast ─────────────────────────────────────────────────────────────────────

let _toastTimer;
function showToast(msg, ms = 3800) {
  const el = document.getElementById('toast');
  clearTimeout(_toastTimer);
  el.textContent = msg;
  el.classList.add('show');
  _toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderItems() {
  const list  = document.getElementById('items-list');
  const mode  = state.splitMode;
  const items = state.order?.items ?? [];

  list.innerHTML = items.map(item => {
    const s = item.status; // 'available' | 'claimed' | 'paid'

    const isPaid      = s === 'paid';
    const isClaimed   = s === 'claimed';
    const isAvail     = s === 'available';
    const isSelectable = isAvail && mode === 'items';
    const isSelected  = isAvail && (
      mode === 'rest'  ? true :
      mode === 'items' ? state.selected.has(item.id) :
      false
    );

    const cls = [
      'item-card',
      isPaid      ? 'paid'      : '',
      isClaimed   ? 'claimed'   : '',
      isSelected  ? 'selected'  : '',
      isSelectable? 'selectable': '',
    ].filter(Boolean).join(' ');

    const checkEl = (isAvail && mode === 'items')
      ? `<div class="item-check">${isSelected ? '✓' : ''}</div>` : '';

    const badge = isPaid    ? '<span class="paid-badge">achitat</span>'
                : isClaimed ? '<span class="claimed-badge">rezervat</span>'
                : '';

    return `
      <li class="${cls}" data-id="${item.id}"
          ${isSelectable ? `role="checkbox" aria-checked="${isSelected}"` : ''}>
        ${checkEl}
        <span class="item-name">${item.name}</span>
        <div class="item-right">
          <span class="item-price">${fmt(parseFloat(item.price_lei))}</span>
          ${badge}
        </div>
      </li>`;
  }).join('');

  list.querySelectorAll('.item-card.selectable').forEach(card => {
    card.addEventListener('click', () => {
      const id = parseInt(card.dataset.id, 10);
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      renderItems();
      renderFooter();
    });
  });
}

function renderFooter() {
  const total = billTotal();
  const paid  = (state.order?.items ?? [])
    .filter(i => i.status === 'paid')
    .reduce((s, i) => s + parseFloat(i.price_lei), 0);
  const rest  = total - paid;

  document.getElementById('bill-total').textContent = fmt(total);
  document.getElementById('bill-paid').textContent  = fmt(paid);
  document.getElementById('bill-rest').textContent  = fmt(rest);
  document.getElementById('my-total').textContent   = fmt(baseAmount());
  document.getElementById('continue-btn').disabled  = baseAmount() <= 0;

  const pct = total > 0 ? (paid / total) * 100 : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
}

function renderEqualPicker() {
  document.getElementById('equal-picker').style.display =
    state.splitMode === 'equal' ? 'flex' : 'none';
  document.getElementById('guest-count').textContent = state.guestCount;
}

function renderBill() {
  document.getElementById('table-badge').textContent = `Masa ${state.tableNumber}`;
  renderItems();
  renderFooter();
  renderEqualPicker();
}

// ── Connection banner ─────────────────────────────────────────────────────────

function setConnBanner(visible, msg) {
  const el = document.getElementById('conn-banner');
  el.textContent = visible ? (msg ?? 'Reconectăm…') : '';
  el.classList.toggle('visible', visible);
}

// ── Socket.io ─────────────────────────────────────────────────────────────────

let _emptyRefreshTimer;

function initSocket() {
  socket = io();

  socket.on('connect', () => {
    setConnBanner(false);
    socket.emit('join-table', state.tableNumber);
    // If we were on the empty screen, try again — order may have appeared.
    if (currentScreen() === 'screen-empty') {
      clearTimeout(_emptyRefreshTimer);
      fetchOrder();
    }
  });

  socket.on('disconnect', () =>
    setConnBanner(true, 'Conexiune pierdută. Reconectăm…'));

  socket.on('connect_error', () =>
    setConnBanner(true, 'Nu ne putem conecta la server.'));

  // Another phone at this table changed something — update our view.
  socket.on('order-update', (newOrder) => {
    state.order = newOrder;

    // Order just appeared while we were on the empty screen → switch to bill.
    if (currentScreen() === 'screen-empty') {
      clearTimeout(_emptyRefreshTimer);
      renderBill();
      showScreen('screen-bill');
      return;
    }

    if (currentScreen() !== 'screen-bill') return;

    // When state.claiming is true this broadcast is the echo of OUR OWN claim —
    // don't touch state.selected (we still need it for the payment screen).
    if (!state.claiming) {
      const taken = (newOrder.items ?? [])
        .filter(i => state.selected.has(i.id) && i.status !== 'available');
      if (taken.length > 0) {
        taken.forEach(i => state.selected.delete(i.id));
        showToast('O poziție tocmai a fost rezervată de altcineva.');
      }
    }

    renderBill();
  });
}

// ── Mode buttons ──────────────────────────────────────────────────────────────

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.splitMode = btn.dataset.mode;
    state.selected.clear();
    document.querySelectorAll('.mode-btn').forEach(b =>
      b.classList.toggle('active', b === btn)
    );
    renderItems();
    renderFooter();
    renderEqualPicker();
  });
});

document.getElementById('guest-minus').addEventListener('click', () => {
  if (state.guestCount > 1) { state.guestCount--; renderEqualPicker(); renderFooter(); }
});
document.getElementById('guest-plus').addEventListener('click', () => {
  state.guestCount++;
  renderEqualPicker();
  renderFooter();
});

// ── "Continuă" — claim items, then show payment screen ───────────────────────

document.getElementById('continue-btn').addEventListener('click', () => {
  const btn = document.getElementById('continue-btn');
  btn.disabled = true;
  btn.textContent = 'Se verifică...';

  const resetBtn = () => {
    btn.disabled = false;
    btn.textContent = 'Continuă →';
  };

  // Capture the amount and item list NOW, before order-update can mutate state.
  // (The server broadcasts order-update before sending the claim ack, so by the time
  // our ack fires, state.selected and state.order may already be stale.)
  state.paymentBase  = baseAmount();
  state.paymentItems = (state.order?.items ?? []).filter(i => state.selected.has(i.id));

  // Equal split doesn't lock specific items — go straight to payment.
  if (state.splitMode === 'equal') {
    resetBtn();
    state.claimedIds = [];
    openPaymentScreen();
    return;
  }

  // Collect which item IDs to claim.
  const itemIds = state.splitMode === 'items'
    ? [...state.selected]
    : (state.order?.items ?? []).filter(i => i.status === 'available').map(i => i.id);

  if (!itemIds.length) { resetBtn(); return; }

  // Set flag so the order-update echo from our own claim doesn't clear state.selected.
  state.claiming = true;

  // Server does atomic UPDATE … WHERE status='available'.
  // If anything is contested, it rolls back all our claims and tells us which failed.
  socket.emit('claim-items', itemIds, (result) => {
    state.claiming = false;
    resetBtn();

    if (result.contested.length > 0) {
      // Someone else beat us — refresh and tell the guest.
      state.order = result.order;
      result.contested.forEach(id => state.selected.delete(id));
      renderBill();
      showToast('O poziție tocmai a fost luată. Încearcă din nou.');
    } else {
      state.claimedIds = result.claimed;
      openPaymentScreen();
    }
  });
});

// ── Payment screen ────────────────────────────────────────────────────────────

function openPaymentScreen() {
  state.tipPct = 0;
  document.querySelectorAll('.tip-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.tip, 10) === 0)
  );

  // Populate items summary using values captured at "Continuă" time.
  const ul   = document.getElementById('pay-items-list');
  const base = state.paymentBase;

  if (state.splitMode === 'equal') {
    ul.innerHTML = `<li class="pay-item-row">
      <span>Cotă egală (1 din ${state.guestCount})</span>
      <span>${fmt(base)}</span></li>`;
  } else if (state.splitMode === 'rest') {
    ul.innerHTML = `<li class="pay-item-row">
      <span>Restul neachitat</span>
      <span>${fmt(base)}</span></li>`;
  } else {
    ul.innerHTML = state.paymentItems.map(i => `
      <li class="pay-item-row">
        <span>${i.name}</span>
        <span>${fmt(parseFloat(i.price_lei))}</span>
      </li>`).join('');
  }

  refreshPaymentAmounts();
  showScreen('screen-payment');
}

function refreshPaymentAmounts() {
  const base  = state.paymentBase;   // fixed at "Continuă" time, doesn't drift
  const tip   = base * state.tipPct / 100;
  const total = base + tip;

  // Hero card
  document.getElementById('pay-amount').textContent = fmt(total);

  // Three-line breakdown
  document.getElementById('breakdown-base').textContent = fmt(base);

  const tipRow = document.getElementById('tip-bd-tip-row');
  if (state.tipPct > 0) {
    tipRow.style.display = 'flex';
    document.getElementById('breakdown-tip-label').textContent = `Bacșiș (${state.tipPct}%)`;
    document.getElementById('breakdown-tip').textContent = fmt(tip);
  } else {
    tipRow.style.display = 'none';
  }

  document.getElementById('tip-total').textContent   = fmt(total);
  document.getElementById('mia-btn-amt').textContent = fmt(total);
}

// Tip buttons.
document.querySelectorAll('.tip-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.tipPct = parseInt(btn.dataset.tip, 10);
    document.querySelectorAll('.tip-btn').forEach(b =>
      b.classList.toggle('active', b === btn)
    );
    refreshPaymentAmounts();
  });
});

// Back from payment → release server-side claims and return to bill.
document.getElementById('back-btn').addEventListener('click', () => {
  if (state.claimedIds.length > 0) {
    socket.emit('release-claims');
    state.claimedIds = [];
  }
  showScreen('screen-bill');
});

// ── MIA button → bank simulation ──────────────────────────────────────────────

document.getElementById('mia-btn').addEventListener('click', () => {
  const total = finalAmount();
  document.getElementById('bank-amount').textContent = fmt(total);

  // Notify server to initiate the MIA Request-to-Pay.
  // In production: server calls the real bank API and returns a deep-link URL
  // to open the customer's banking app. Here it just logs the attempt.
  fetch('/api/payment/initiate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amountLei: total, socketId: socket.id }),
  }).catch(() => {}); // non-blocking — mock bank screen shows regardless

  showScreen('screen-bank');
});

// Bank screen — close/cancel (keep claims, return to payment screen).
document.getElementById('bank-close-btn').addEventListener('click',  () => showScreen('screen-payment'));
document.getElementById('bank-cancel-link').addEventListener('click', () => showScreen('screen-payment'));

// Bank screen — guest taps "Confirmă plata".
document.getElementById('bank-confirm-btn').addEventListener('click', () => {
  const btn = document.getElementById('bank-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Se procesează...';

  const finish = () => {
    btn.disabled = false;
    btn.textContent = 'Confirmă plata';
    buildReceipt();
    showScreen('screen-success');
  };

  if (state.splitMode === 'equal') {
    // No server-side claim for equal split — simulate locally.
    setTimeout(finish, 1200);
    return;
  }

  // Tell the server to mark our claimed items as paid (include tip for analytics).
  const tipLei = Math.round(state.paymentBase * state.tipPct) / 100;
  socket.emit('pay-claimed', { tipLei }, (result) => {
    if (result.success) finish();
    else {
      btn.disabled = false;
      btn.textContent = 'Confirmă plata';
      showToast('Ceva nu a mers. Încearcă din nou.');
    }
  });
});

// ── Receipt ───────────────────────────────────────────────────────────────────

function buildReceipt() {
  const now     = new Date();
  const dateStr = now.toLocaleDateString('ro-RO', { day: 'numeric', month: 'long', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
  const nr      = 'NF-' + now.getFullYear() + '-' + String(Math.floor(Math.random() * 900000) + 100000);

  document.getElementById('receipt-restaurant-line').textContent = 'Carmelo · Ristorante';
  document.getElementById('receipt-table-line').textContent = `Masa ${state.tableNumber} · ${dateStr}, ${timeStr}`;
  document.getElementById('receipt-nr-line').textContent = nr;

  const base   = state.paymentBase;
  const total  = finalAmount();  // state.paymentBase * (1 + tipPct/100)
  const tip    = total - base;
  const vat    = base / 6; // 20% VAT included → VAT = price × 0.2/1.2

  const el = document.getElementById('receipt-items');

  if (state.splitMode === 'equal') {
    el.innerHTML = `
      <li class="receipt-item">
        <span class="receipt-item-name">Cotă egală (1 din ${state.guestCount})</span>
        <span class="receipt-item-price">${fmt(base)}</span>
      </li>`;
  } else if (state.splitMode === 'rest') {
    el.innerHTML = `
      <li class="receipt-item">
        <span class="receipt-item-name">Restul neachitat</span>
        <span class="receipt-item-price">${fmt(base)}</span>
      </li>`;
  } else {
    const paid = (state.order?.items ?? []).filter(i => state.claimedIds.includes(i.id));
    el.innerHTML = paid.map(i => `
      <li class="receipt-item">
        <span class="receipt-item-name">${i.name}</span>
        <span class="receipt-item-price">${fmt(parseFloat(i.price_lei))}</span>
      </li>`).join('');
  }

  if (tip > 0.005) {
    el.innerHTML += `
      <li class="receipt-item tip-line">
        <span class="receipt-item-name">Bacșiș (${state.tipPct}%)</span>
        <span class="receipt-item-price">${fmt(tip)}</span>
      </li>`;
  }

  document.getElementById('receipt-total').textContent = fmt(total);
  document.getElementById('receipt-vat').textContent   = fmt(vat);
}

// ── Success → back to bill ────────────────────────────────────────────────────

document.getElementById('home-btn').addEventListener('click', () => {
  state.splitMode = 'items';
  state.selected.clear();
  state.claimedIds = [];
  state.tipPct = 0;
  document.querySelectorAll('.mode-btn').forEach((b, i) =>
    b.classList.toggle('active', i === 0)
  );
  fetchOrder();
});

// ── Data loading ──────────────────────────────────────────────────────────────

async function fetchOrder() {
  showScreen('screen-loading');
  try {
    const res = await fetch(`/api/table/${state.tableNumber}`);

    if (res.status === 404) {
      // Table exists but no open order yet — waiter hasn't started the session.
      document.getElementById('empty-table-badge').textContent =
        `Masa ${state.tableNumber}`;
      showScreen('screen-empty');
      // Auto-retry every 30 s in case a socket event doesn't fire.
      _emptyRefreshTimer = setTimeout(() => {
        if (currentScreen() === 'screen-empty') fetchOrder();
      }, 30_000);
      return;
    }

    if (!res.ok) throw new Error(await res.text());
    state.order = await res.json();
    renderBill();
    showScreen('screen-bill');
  } catch (err) {
    document.getElementById('error-text').textContent =
      err.message || 'Comanda nu a putut fi încărcată.';
    showScreen('screen-error');
  }
}

function init() {
  const params = new URLSearchParams(window.location.search);
  state.tableNumber = parseInt(params.get('t') ?? '0', 10);

  if (!state.tableNumber || isNaN(state.tableNumber)) {
    document.getElementById('error-text').textContent =
      'Parametrul ?t= (numărul mesei) lipsește din URL.';
    showScreen('screen-error');
    return;
  }

  initSocket();
  fetchOrder();
}

init();
