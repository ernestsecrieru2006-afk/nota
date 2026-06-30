// Dashboard — restaurant owner view. Reads from /api/dashboard/* and
// receives real-time payment events from Socket.io.

const socket = io();

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtLei(n) {
  const v = parseFloat(n) || 0;
  return v.toLocaleString('ro-RO', {
    minimumFractionDigits: v % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }) + ' lei';
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('ro-RO', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── Socket.io ─────────────────────────────────────────────────────────────────

socket.on('connect', () => socket.emit('join-dashboard'));

socket.on('payment-made', (payment) => {
  prependPaymentRow(payment, true);
  // Refresh stat cards — they're quick single-row queries.
  loadStats();
  loadHourly();
});

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadStats() {
  const d = await fetch('/api/dashboard/stats').then(r => r.json());
  document.getElementById('stat-incasat').textContent   = fmtLei(d.incasat);
  document.getElementById('stat-plati').textContent     = d.nr_plati ?? 0;
  document.getElementById('stat-bacsisuri').textContent = fmtLei(d.bacsisuri);
  document.getElementById('stat-mese').textContent      = d.mese ?? 0;
}

async function loadTopDishes() {
  const data = await fetch('/api/dashboard/top-dishes').then(r => r.json());
  const el   = document.getElementById('top-dishes');

  if (!data.length) {
    el.innerHTML = '<p class="empty-state">Nicio vânzare înregistrată azi.</p>';
    return;
  }

  el.innerHTML = data.map((d, i) => `
    <div class="dish-row">
      <span class="dish-rank">${i + 1}</span>
      <span class="dish-name">${escHtml(d.name)}</span>
      <span class="dish-count">${d.cnt}×</span>
      <span class="dish-total">${fmtLei(d.total_lei)}</span>
    </div>
  `).join('');
}

async function loadHourly() {
  const data = await fetch('/api/dashboard/hourly').then(r => r.json());
  renderBarChart(data);
}

async function loadRecent() {
  const data = await fetch('/api/dashboard/recent').then(r => r.json());
  const el   = document.getElementById('recent-payments');

  if (!data.length) {
    el.innerHTML = '<p class="empty-state">Nicio plată încă azi.</p>';
    return;
  }

  el.innerHTML = data.map(p => paymentRowHTML(p, false)).join('');
}

// ── Bar chart (CSS-only, no library) ─────────────────────────────────────────

function renderBarChart(data) {
  const el = document.getElementById('hourly-chart');

  // Show hours 8–23 (typical restaurant range).
  const hours   = Array.from({ length: 16 }, (_, i) => i + 8);
  const hourMap = {};
  data.forEach(d => { hourMap[parseInt(d.ora)] = parseFloat(d.total); });

  const maxVal = Math.max(...hours.map(h => hourMap[h] || 0), 1);

  const bars = hours.map(h => {
    const val     = hourMap[h] || 0;
    const pct     = ((val / maxVal) * 88).toFixed(1); // 88% max so top isn't clipped
    const hasData = val > 0;
    const tip     = hasData ? fmtLei(val) : '';
    return `
      <div class="bar-col" title="${tip}">
        <div class="bar-fill ${hasData ? 'has-data' : ''}" style="height:${pct}%"></div>
        <span class="bar-lbl">${h}</span>
      </div>`;
  }).join('');

  el.innerHTML = `<div class="bar-chart-inner">${bars}</div>`;
}

// ── Recent payments ───────────────────────────────────────────────────────────

function paymentRowHTML(p, isNew) {
  const tableNum = p.table_number ?? p.tableNumber;
  const amount   = parseFloat(p.amount_lei ?? p.amount ?? 0);
  const tip      = parseFloat(p.tip_lei    ?? p.tip    ?? 0);
  const time     = fmtTime(p.paid_at ?? p.paidAt);
  const total    = amount + tip;

  return `
    <div class="payment-row ${isNew ? 'is-new' : ''}">
      <div class="pr-dot ${tip > 0 ? 'tip' : ''}"></div>
      <div class="pr-table">Masa ${tableNum}</div>
      <div class="pr-mid">
        <span class="pr-amount">${fmtLei(total)}</span>
        ${tip > 0 ? `<span class="pr-tip">incl. ${fmtLei(tip)} bacșiș</span>` : ''}
      </div>
      <div class="pr-time">${time}</div>
    </div>`;
}

function prependPaymentRow(p, isNew) {
  const el    = document.getElementById('recent-payments');
  const empty = el.querySelector('.empty-state');
  if (empty) el.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.innerHTML = paymentRowHTML(p, isNew).trim();
  el.prepend(wrap.firstChild);
}

// ── Safety: escape HTML in dish names ────────────────────────────────────────

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Dev seed button ───────────────────────────────────────────────────────────

document.getElementById('seed-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Se adaugă…';

  const res = await fetch('/api/dev/seed-payments', { method: 'POST' });
  const d   = await res.json();

  if (d.seeded) {
    btn.textContent = `✓ ${d.seeded} plăți adăugate`;
    await Promise.all([loadStats(), loadTopDishes(), loadHourly(), loadRecent()]);
  } else {
    btn.textContent = d.error ?? 'Eroare';
    btn.disabled = false;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

document.getElementById('date-label').textContent = new Date().toLocaleDateString('ro-RO', {
  weekday: 'long',
  day:     'numeric',
  month:   'long',
  year:    'numeric',
});

Promise.all([loadStats(), loadTopDishes(), loadHourly(), loadRecent()]);
