/**
 * waiter.js — /waiter live table view for floor staff.
 *
 * Deliberately external (not inline), mirroring club-scanner.js's precedent: all logic in one
 * auditable file, no inline event-handler attributes anywhere (addEventListener only), matching
 * the app's CSP (scriptSrcAttr: 'none').
 *
 * Auth: a staff JWT in localStorage, obtained by redeeming a link token + PIN against
 * /api/staff/redeem. The link token itself is also persisted (not just the resulting JWT),
 * because once this page is installed to a home screen its start_url has no ?link= query param
 * — without persisting the link token separately, a re-auth after revocation would have nothing
 * to redeem against.
 */
(() => {
  'use strict';

  // ── i18n ──────────────────────────────────────────────────────────────
  const STR = {
    ro: {
      checking:    'Se verifică accesul…',
      askPin:      name => `Introdu PIN-ul pentru ${name || 'restaurant'}`,
      enter:       'Intră',
      welcomeBack: name => `Bun venit înapoi${name ? ' — ' + name : ''}`,
      startShift:  'Începe tura',
      invalidLink: 'Acest link nu este valid. Cere linkul de acces de la manager.',
      wrongPin:    'PIN incorect.',
      tooMany:     'Prea multe încercări — încearcă mai târziu.',
      revoked:     'Acces revocat de manager.',
      genericErr:  'Eroare — încearcă din nou.',
      disconnected:'⚠ Deconectat — se reconectează…',
      free:        'Liberă',
      occupied:    'Ocupată',
      paying:      'Plată în curs',
      paid:        'Plătit ✓',
      call:        'Cheamă ospătarul',
      ack:         'Preiau',
      emptyState:  'Nicio masă configurată.',
      wakeNote:    'Ține telefonul conectat la curent pentru a evita stingerea ecranului.',
      lei:         'lei neachitat',
    },
    ru: {
      checking:    'Проверка доступа…',
      askPin:      name => `Введите PIN для ${name || 'ресторана'}`,
      enter:       'Войти',
      welcomeBack: name => `С возвращением${name ? ' — ' + name : ''}`,
      startShift:  'Начать смену',
      invalidLink: 'Ссылка недействительна. Запросите ссылку у менеджера.',
      wrongPin:    'Неверный PIN.',
      tooMany:     'Слишком много попыток — попробуйте позже.',
      revoked:     'Доступ отозван менеджером.',
      genericErr:  'Ошибка — попробуйте снова.',
      disconnected:'⚠ Нет соединения — переподключение…',
      free:        'Свободен',
      occupied:    'Занят',
      paying:      'Оплата идёт',
      paid:        'Оплачено ✓',
      call:        'Зовёт официанта',
      ack:         'Принять',
      emptyState:  'Нет столов.',
      wakeNote:    'Держите телефон на зарядке, чтобы экран не гас.',
      lei:         'лей к оплате',
    },
  };

  let lang = localStorage.getItem('nota_waiter_lang') || 'ro';
  const t = (key, ...args) => {
    const v = STR[lang][key];
    return typeof v === 'function' ? v(...args) : v;
  };

  // ── DOM refs ──────────────────────────────────────────────────────────
  const el = id => document.getElementById(id);
  const startScreen  = el('start-screen');
  const gridScreen   = el('grid-screen');
  const startMsg     = el('start-msg');
  const pinInput      = el('pin-input');
  const startBtn      = el('start-btn');
  const startError    = el('start-error');
  const connBanner    = el('conn-banner');
  const gridEl        = el('grid');
  const emptyState    = el('empty-state');
  const tbRestaurant   = el('tb-restaurant');
  const muteBtn        = el('mute-btn');
  const langBtn        = el('lang-btn');
  const wakeNote       = el('wakelock-note');

  // ── State ─────────────────────────────────────────────────────────────
  const params        = new URLSearchParams(location.search);
  const urlLinkToken   = params.get('link');
  let staffToken       = localStorage.getItem('nota_staff_token');
  let restaurantName   = localStorage.getItem('nota_staff_restaurant') || '';
  // Persisted separately from staffToken: once installed to a home screen, start_url has no
  // ?link= param, so a later re-auth (e.g. after revoke) needs this to redeem against.
  let linkToken = urlLinkToken || localStorage.getItem('nota_staff_link_token') || null;
  if (urlLinkToken) localStorage.setItem('nota_staff_link_token', urlLinkToken);

  let muted = localStorage.getItem('nota_waiter_muted') === '1';

  let tables = [];                // last fetched table rows, merged with waiter_call_at
  const recentlyPaid = new Map(); // tableNumber -> paidAt ms
  const RECENT_PAID_WINDOW_MS = 120_000;

  let socket = null;
  let audioCtx = null;
  let wakeLock = null;

  // ── Audio — Web Audio oscillator beeps: no asset files, trivially CSP-safe, distinct tones
  // are just different frequencies from one shared AudioContext. Must be created/resumed inside
  // a user-gesture handler (browsers block autoplay otherwise) — see enterShift().
  function ensureAudio() {
    if (audioCtx) { if (audioCtx.state === 'suspended') audioCtx.resume(); return; }
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { audioCtx = null; }
  }

  function beep(freq, startAt, durationSec, gain = 0.3) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const g   = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.value = gain;
    osc.connect(g).connect(audioCtx.destination);
    osc.start(startAt);
    osc.stop(startAt + durationSec);
  }

  function playAlert(kind) {
    if (muted || !audioCtx) return;
    const now = audioCtx.currentTime;
    if (kind === 'call') {
      beep(880, now, 0.14); beep(880, now + 0.22, 0.14); beep(880, now + 0.44, 0.14);
    } else if (kind === 'paid') {
      beep(523, now, 0.16); beep(659, now + 0.18, 0.22);
    }
  }

  // iOS Safari has no Vibration API at all — this silently no-ops there, sound + visual only.
  function vibrate(kind) {
    if (muted || !('vibrate' in navigator)) return;
    navigator.vibrate(kind === 'call' ? [200, 100, 200, 100, 200] : [300]);
  }

  // ── Wake Lock — releases automatically when the tab is hidden and does NOT auto-reacquire,
  // so it must be re-requested on every visibilitychange back to visible.
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) { wakeNote.textContent = t('wakeNote'); wakeNote.classList.add('show'); return; }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeNote.classList.remove('show');
    } catch {
      wakeNote.textContent = t('wakeNote');
      wakeNote.classList.add('show');
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (gridScreen.style.display === 'block') requestWakeLock();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    if (socket) {
      if (socket.connected) loadTables(); // covers silent staleness after a phone sleeps/wakes
      else socket.connect();
    }
  });

  // ── Connection banner — persistent while disconnected, never a fading toast ────────────
  function setConnBanner(state) {
    if (state === 'disconnected') {
      connBanner.textContent = t('disconnected');
      connBanner.classList.add('show');
    } else {
      connBanner.classList.remove('show');
    }
  }

  // ── API helper ────────────────────────────────────────────────────────
  async function staffApi(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}`, ...(opts.headers || {}) },
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }

  // ── Table grid rendering ─────────────────────────────────────────────
  function tableStatus(tbl) {
    if (tbl.waiter_call_at) return 'call';
    if (tbl.payment_pending) return 'paying';
    if (Number(tbl.unpaid_lei) > 0) return 'occupied';
    const paidAt = recentlyPaid.get(Number(tbl.number));
    if (paidAt && Date.now() - paidAt < RECENT_PAID_WINDOW_MS) return 'paid';
    return 'free';
  }

  const STATUS_WEIGHT = { call: 0, paying: 1, occupied: 2, paid: 3, free: 4 };

  function sortedTables() {
    return [...tables].sort((a, b) => {
      const sa = tableStatus(a), sb = tableStatus(b);
      const wa = STATUS_WEIGHT[sa], wb = STATUS_WEIGHT[sb];
      if (wa !== wb) return wa - wb;
      if (sa === 'call') return (a.waiter_call_at || 0) - (b.waiter_call_at || 0);
      return Number(a.number) - Number(b.number);
    });
  }

  function renderGrid() {
    const sorted = sortedTables();
    if (!sorted.length) {
      gridEl.innerHTML = '';
      emptyState.textContent = t('emptyState');
      emptyState.style.display = '';
      return;
    }
    emptyState.style.display = 'none';
    gridEl.innerHTML = sorted.map(tbl => {
      const status = tableStatus(tbl);
      const label  = t(status);
      let sub = '';
      if (status === 'occupied') sub = `${Math.round(Number(tbl.unpaid_lei))} ${t('lei')}`;
      const ackBtn = status === 'call'
        ? `<button class="ack-btn" data-ack="${tbl.number}" type="button">${t('ack')}</button>` : '';
      return `
        <div class="tcard ${status}">
          <div>
            <div class="t-num">${tbl.number}</div>
            <div class="t-label">${label}</div>
            ${sub ? `<div class="t-sub">${sub}</div>` : ''}
          </div>
          ${ackBtn}
        </div>`;
    }).join('');
  }

  gridEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-ack]');
    if (!btn) return;
    const tableNumber = Number(btn.dataset.ack);
    btn.disabled = true; // clears for real via the server broadcast regardless
    if (socket && socket.connected) socket.emit('waiter-call-ack', { tableNumber });
    else staffApi(`/api/staff/tables/${tableNumber}/ack`, { method: 'POST' });
  });

  // ── Data loading ─────────────────────────────────────────────────────
  // Returns false if the session was revoked mid-request (caller must stop, handleRevoked()
  // already cleaned up); true otherwise, including on a transient network error (keep showing
  // the last known state rather than blanking the grid).
  async function loadTables() {
    const { status, data } = await staffApi('/api/staff/tables');
    if (status === 401) { handleRevoked(); return false; }
    if (status !== 200 || !Array.isArray(data)) return true;
    tables = data;
    renderGrid();
    return true;
  }

  let activityRefreshTimer = null;
  function scheduleActivityRefresh() {
    clearTimeout(activityRefreshTimer);
    activityRefreshTimer = setTimeout(loadTables, 250);
  }

  // ── Socket wiring ─────────────────────────────────────────────────────
  function connectSocket() {
    socket = io();

    socket.on('connect', async () => {
      setConnBanner('connected');
      const ok = await loadTables(); // full authoritative re-fetch, not "resume listening"
      if (!ok) return;
      socket.emit('join-staff', { token: staffToken }, ack => {
        if (ack && ack.error) handleRevoked();
      });
    });

    socket.on('disconnect', () => setConnBanner('disconnected'));
    socket.on('staff-revoked', () => handleRevoked());

    // Alerting events — sound + vibration + visual highlight.
    socket.on('waiter-called', ({ tableNumber }) => {
      const row = tables.find(x => Number(x.number) === Number(tableNumber));
      if (row) row.waiter_call_at = Date.now();
      renderGrid();
      playAlert('call');
      vibrate('call');
    });

    socket.on('payment-made', ({ table_number }) => {
      recentlyPaid.set(Number(table_number), Date.now());
      loadTables(); // unpaid_lei is now stale in the cached row — pull the fresh figure
      playAlert('paid');
      vibrate('paid');
    });

    // Non-alerting — clears/refreshes silently, never triggers sound/vibration.
    socket.on('waiter-call-acked', ({ tableNumber }) => {
      const row = tables.find(x => Number(x.number) === Number(tableNumber));
      if (row) row.waiter_call_at = null;
      renderGrid();
    });
    socket.on('table-activity', () => scheduleActivityRefresh());
  }

  function handleRevoked() {
    localStorage.removeItem('nota_staff_token');
    localStorage.removeItem('nota_staff_restaurant');
    staffToken = null;
    if (socket) { socket.disconnect(); socket = null; }
    gridScreen.style.display = 'none';
    startScreen.style.display = 'flex';
    if (linkToken) showPinEntry(); else showInvalidLink();
    startError.textContent = t('revoked');
  }

  // ── Auth flow ─────────────────────────────────────────────────────────
  function showPinEntry() {
    startMsg.textContent = t('askPin', restaurantName);
    pinInput.style.display = '';
    startBtn.textContent = t('enter');
    startBtn.style.display = '';
    startBtn.dataset.mode = 'pin';
    pinInput.value = '';
    pinInput.focus();
  }

  function showWelcomeBack() {
    startMsg.textContent = t('welcomeBack', restaurantName);
    pinInput.style.display = 'none';
    startBtn.textContent = t('startShift');
    startBtn.style.display = '';
    startBtn.dataset.mode = 'resume';
  }

  function showInvalidLink() {
    startMsg.textContent = t('invalidLink');
    pinInput.style.display = 'none';
    startBtn.style.display = 'none';
  }

  async function enterShift() {
    ensureAudio();       // user gesture — required before any sound can ever play
    requestWakeLock();
    startScreen.style.display = 'none';
    gridScreen.style.display = 'block';
    tbRestaurant.textContent = restaurantName || '';
    const ok = await loadTables();
    if (!ok) return; // revoked mid-flight — handleRevoked() already reset the screen
    connectSocket();
  }

  async function submitPin() {
    const pin = pinInput.value.trim();
    if (pin.length !== 6) { startError.textContent = t('wrongPin'); return; }
    startError.textContent = '';
    startBtn.disabled = true;
    try {
      const res = await fetch('/api/staff/redeem', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkToken, pin }),
      });
      const data = await res.json().catch(() => ({}));
      startBtn.disabled = false;
      if (res.status === 429) { startError.textContent = t('tooMany'); return; }
      if (!res.ok || data.error) { startError.textContent = t('wrongPin'); pinInput.value = ''; pinInput.focus(); return; }
      staffToken = data.token;
      restaurantName = data.restaurantName || '';
      localStorage.setItem('nota_staff_token', staffToken);
      localStorage.setItem('nota_staff_restaurant', restaurantName);
      localStorage.setItem('nota_staff_link_token', linkToken);
      enterShift(); // this tap is the user gesture that unlocks audio
    } catch {
      startBtn.disabled = false;
      startError.textContent = t('genericErr');
    }
  }

  startBtn.addEventListener('click', () => {
    if (startBtn.dataset.mode === 'resume') enterShift();
    else submitPin();
  });
  pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitPin(); });

  muteBtn.addEventListener('click', () => {
    muted = !muted;
    localStorage.setItem('nota_waiter_muted', muted ? '1' : '0');
    muteBtn.textContent = muted ? '🔇' : '🔊';
    muteBtn.classList.toggle('active-mute', muted);
  });
  muteBtn.textContent = muted ? '🔇' : '🔊';
  muteBtn.classList.toggle('active-mute', muted);

  langBtn.addEventListener('click', () => {
    lang = lang === 'ro' ? 'ru' : 'ro';
    localStorage.setItem('nota_waiter_lang', lang);
    langBtn.textContent = lang.toUpperCase();
    renderGrid();
    if (startBtn.dataset.mode === 'resume') showWelcomeBack();
    else if (pinInput.style.display !== 'none') showPinEntry();
  });
  langBtn.textContent = lang.toUpperCase();

  // ── Boot ──────────────────────────────────────────────────────────────
  (async function boot() {
    startMsg.textContent = t('checking');
    if (staffToken) {
      const { status } = await staffApi('/api/staff/tables');
      if (status === 200) { showWelcomeBack(); return; }
      localStorage.removeItem('nota_staff_token');
      localStorage.removeItem('nota_staff_restaurant');
      staffToken = null;
    }
    if (linkToken) { showPinEntry(); return; }
    showInvalidLink();
  })();
})();
