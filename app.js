/* Poker Tracker — a tiny static tracker for home games.
   No build step, no framework. Two storage modes:
   - local:  state lives in this browser's localStorage (optionally seeded from a
             published data.json next to the page);
   - shared: when config.js provides Firebase settings, one live table in Firebase
             Realtime Database that every visitor reads and writes in real time. */
(() => {
  'use strict';

  const STORAGE_KEY = 'poker-tracker:v1';
  const FIREBASE_VERSION = '10.14.1';
  const EMOJIS = ['🦊', '🐻', '🦁', '🐯', '🐺', '🦅', '🐙', '🦈', '🐸', '🦉',
                  '🐼', '🦄', '🐲', '🦩', '🐧', '🦖', '🎩', '🕶️', '🃏', '🎲'];

  const CFG = (typeof window.POKER_CONFIG === 'object' && window.POKER_CONFIG) || null;
  const SHARED = !!(CFG && CFG.firebase && (CFG.firebase.databaseURL || CFG.firebase.projectId));
  const TABLE_ID = String((CFG && CFG.tableId) || 'main').replace(/[.#$[\]/]/g, '-');

  let state = SHARED ? blank() : load();
  let cloud = null;                                  // { update, set, get } once connected
  let cloudStatus = SHARED ? 'connecting' : 'off';   // off | connecting | slow | live | error
  let publishedAt = null;                            // updatedAt of a data.json found next to the page
  let historyFilter = '';                            // playerId filter on the log page

  /* ---------------- data model ---------------- */
  function blank() {
    return { version: 1, updatedAt: null, settings: { currency: '$' }, players: [], results: [] };
  }

  function normalize(d) {
    const b = blank();
    if (!d || typeof d !== 'object') return b;
    const players = Array.isArray(d.players) ? d.players : [];
    const results = Array.isArray(d.results) ? d.results : [];
    b.updatedAt = typeof d.updatedAt === 'string' ? d.updatedAt : null;
    b.settings.currency = (d.settings && typeof d.settings.currency === 'string' && d.settings.currency.trim()) || '$';
    b.players = players
      .filter(p => p && p.id != null && p.name)
      .map(p => ({
        id: String(p.id),
        name: String(p.name).slice(0, 40),
        emoji: p.emoji ? String(p.emoji) : '🃏',
        createdAt: p.createdAt || null
      }));
    const ids = new Set(b.players.map(p => p.id));
    b.results = results
      .filter(r => r && r.id != null && ids.has(String(r.playerId)) && r.date && Number.isFinite(Number(r.amount)))
      .map(r => ({
        id: String(r.id),
        playerId: String(r.playerId),
        date: String(r.date).slice(0, 10),
        amount: Number(r.amount),
        note: r.note ? String(r.note).slice(0, 80) : '',
        createdAt: r.createdAt || null
      }));
    return b;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) { /* corrupt or blocked storage: start fresh */ }
    return blank();
  }

  function persist() {
    if (cloud) return; // shared mode: Firebase is the source of truth
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('Could not save: browser storage is blocked', 'error');
    }
  }

  /* Firebase tree <-> app state. The tree keeps players/results as maps keyed by id so
     several people can write at once without overwriting each other. */
  const playerRec = p => ({ name: p.name, emoji: p.emoji, createdAt: p.createdAt || null });
  const resultRec = r => ({ playerId: r.playerId, date: r.date, amount: r.amount, note: r.note || '', createdAt: r.createdAt || null });

  function toTree(d) {
    const players = {}, results = {};
    d.players.forEach(p => { players[p.id] = playerRec(p); });
    d.results.forEach(r => { results[r.id] = resultRec(r); });
    return { settings: { currency: d.settings.currency || '$' }, players, results, updatedAt: d.updatedAt || new Date().toISOString() };
  }

  function fromTree(t) {
    if (!t || typeof t !== 'object') return blank();
    const players = Object.entries(t.players || {}).map(([id, p]) => Object.assign({ id }, p));
    const results = Object.entries(t.results || {}).map(([id, r]) => Object.assign({ id }, r));
    players.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    return normalize({ version: 1, updatedAt: t.updatedAt, settings: t.settings, players, results });
  }

  /* One entry point for every change: apply locally, render, then push to the shared
     table (a multi-path update or a full set). If the table rejects it, reload from it. */
  async function mutate(localFn, cloudWrites, msg) {
    localFn(state);
    state.updatedAt = new Date().toISOString();
    persist();
    render();
    if (msg) toast(msg);
    if (!cloud) return;
    try {
      const w = typeof cloudWrites === 'function' ? cloudWrites() : cloudWrites;
      if (w && 'set' in w) await cloud.set(w.set);
      else if (w && w.update) await cloud.update(Object.assign({}, w.update, { updatedAt: state.updatedAt }));
    } catch (e) {
      toast(`The shared table rejected that change (${e.code || e.message})`, 'error');
      try { state = fromTree((await cloud.get()).val()); render(); } catch (e2) { /* keep local view */ }
    }
  }

  const nowIso = () => new Date().toISOString();

  function addPlayer(name, emoji) {
    const p = { id: uid(), name, emoji, createdAt: nowIso() };
    return mutate(s => s.players.push(p), { update: { [`players/${p.id}`]: playerRec(p) } }, `${name} joined the table`);
  }
  function updatePlayer(id, name, emoji) {
    return mutate(s => { const p = s.players.find(x => x.id === id); if (p) Object.assign(p, { name, emoji }); },
      { update: { [`players/${id}/name`]: name, [`players/${id}/emoji`]: emoji } }, `${name} updated`);
  }
  function removePlayer(id, name) {
    const upd = { [`players/${id}`]: null };
    state.results.filter(r => r.playerId === id).forEach(r => { upd[`results/${r.id}`] = null; });
    return mutate(s => { s.players = s.players.filter(x => x.id !== id); s.results = s.results.filter(r => r.playerId !== id); },
      { update: upd }, `${name} removed`);
  }
  function addResults(list, msg) {
    const upd = {};
    list.forEach(r => { upd[`results/${r.id}`] = resultRec(r); });
    return mutate(s => s.results.push(...list), { update: upd }, msg);
  }
  function removeResult(id) {
    return mutate(s => { s.results = s.results.filter(x => x.id !== id); }, { update: { [`results/${id}`]: null } }, 'Result deleted');
  }
  function setCurrency(c) {
    return mutate(s => { s.settings.currency = c; }, { update: { 'settings/currency': c } }, 'Currency updated');
  }
  function replaceAll(d, msg) {
    return mutate(s => Object.assign(s, d), () => ({ set: toTree(state) }), msg);
  }

  /* ---------------- shared table (Firebase) ---------------- */
  async function connectCloud() {
    const slowTimer = setTimeout(() => { if (cloudStatus === 'connecting') { cloudStatus = 'slow'; render(); } }, 8000);
    try {
      const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
      const [appMod, dbMod] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-database.js')]);
      const app = appMod.initializeApp(CFG.firebase);
      const db = dbMod.getDatabase(app);
      const root = dbMod.ref(db, `tables/${TABLE_ID}`);
      const api = { update: v => dbMod.update(root, v), set: v => dbMod.set(root, v), get: () => dbMod.get(root) };
      dbMod.onValue(root, snap => {
        clearTimeout(slowTimer);
        const first = !cloud;
        cloud = api;
        cloudStatus = 'live';
        state = fromTree(snap.val());
        render();
        if (first) toast('Connected to the shared table');
      }, err => {
        clearTimeout(slowTimer);
        const code = String(err.code || err.message || '');
        cloudFailed(/PERMISSION_DENIED/i.test(code)
          ? 'The database rules block access. Publish the rules from the README in the Firebase console, then reload'
          : `Shared table unavailable (${code})`);
      });
    } catch (e) {
      clearTimeout(slowTimer);
      cloudFailed('Could not load the shared database library');
    }
  }

  function cloudFailed(msg) {
    cloud = null;
    cloudStatus = 'error';
    state = load();
    render();
    toast(`${msg}. Working locally in this browser.`, 'error');
  }

  function useLocal() {
    cloud = null;
    cloudStatus = 'off';
    state = load();
    render();
  }

  /* Local mode only: adopt a published data.json when it is newer than the local copy. */
  async function syncFromPublished() {
    if (SHARED || location.protocol === 'file:') return;
    try {
      const res = await fetch('data.json', { cache: 'no-store' });
      if (!res.ok) return;
      const remote = normalize(await res.json());
      if (!remote.players.length) return;
      publishedAt = remote.updatedAt || '';
      const localTs = state.updatedAt || '';
      if (!state.players.length || (remote.updatedAt && remote.updatedAt > localTs)) {
        state = remote;
        persist();
        render();
        toast('Loaded the latest published standings');
      }
    } catch (e) { /* no data.json published yet */ }
  }

  /* ---------------- helpers ---------------- */
  const cur = () => state.settings.currency || '$';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const signClass = n => n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero';
  const playerById = id => state.players.find(p => p.id === id);
  const byName = (a, b) => a.name.localeCompare(b.name);
  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function fmtMoney(n, { sign = true } = {}) {
    const abs = Math.abs(n);
    const num = abs.toLocaleString(undefined, { maximumFractionDigits: Number.isInteger(abs) ? 0 : 2 });
    const s = n < 0 ? '−' : (sign && n > 0 ? '+' : '');
    return `${s}${cur()}${num}`;
  }

  function toISODate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const today = () => toISODate(new Date());

  function fmtDate(iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
    const [y, m, d] = String(iso).split('-').map(Number);
    const dt = new Date(y, (m || 1) - 1, d || 1);
    return isNaN(dt) ? iso : dt.toLocaleDateString(undefined, opts);
  }
  function fmtDateTime(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function byDateDesc(a, b) {
    return b.date.localeCompare(a.date) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  }

  /* ---------------- stats ---------------- */
  function playerStats(p) {
    const rs = state.results.filter(r => r.playerId === p.id).sort(byDateDesc);
    const net = rs.reduce((s, r) => s + r.amount, 0);
    const games = rs.length;
    const wins = rs.filter(r => r.amount > 0).length;
    return {
      player: p, results: rs, net, games, wins,
      winRate: games ? wins / games : 0,
      avg: games ? Math.round(net / games) : 0,
      best: games ? Math.max(...rs.map(r => r.amount)) : 0,
      worst: games ? Math.min(...rs.map(r => r.amount)) : 0,
      last5: rs.slice(0, 5)
    };
  }
  const allStats = () => state.players.map(playerStats);
  // Standings: players with results first, by net (then win rate); players without results last.
  const rankStats = stats => stats.slice().sort((a, b) =>
    (b.games > 0) - (a.games > 0) || b.net - a.net || b.winRate - a.winRate || byName(a.player, b.player));

  function nights() {
    const map = new Map();
    for (const r of state.results) {
      if (!map.has(r.date)) map.set(r.date, []);
      map.get(r.date).push(r);
    }
    return [...map.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, rs]) => ({
        date,
        results: rs.slice().sort((a, b) => b.amount - a.amount),
        note: (rs.find(r => r.note) || {}).note || ''
      }));
  }

  /* ---------------- router / render ---------------- */
  const ROUTES = { dashboard: renderDashboard, players: renderPlayers, log: renderLog };

  function route() {
    const m = location.hash.match(/^#\/?([a-z]+)/);
    return m && ROUTES[m[1]] ? m[1] : 'dashboard';
  }

  let lastRoute = null;
  function render() {
    const r = route();
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.route === r));
    const app = document.getElementById('app');
    if (cloudStatus === 'connecting' || cloudStatus === 'slow') {
      app.innerHTML = connectingView();
      app.dataset.view = 'connecting';
    } else {
      app.innerHTML = ROUTES[r]();
      app.dataset.view = r;
      if (r !== lastRoute) { window.scrollTo(0, 0); lastRoute = r; }
      if (r === 'dashboard') drawNetChart();
      if (r === 'log') updateNightBalance();
    }
    renderStatusPill();
  }

  function renderStatusPill() {
    const el = document.getElementById('sync-pill');
    if (!el) return;
    const map = {
      off: ['', 'Local only'],
      connecting: ['busy', 'Connecting…'],
      slow: ['busy', 'Connecting…'],
      live: ['live', 'Live · shared table'],
      error: ['err', 'Shared table offline · local mode']
    };
    const [cls, label] = map[cloudStatus];
    el.className = `pill ${cls}`;
    el.textContent = label;
  }

  function connectingView() {
    return `<section class="empty">
      <div class="spinner" aria-hidden="true"></div>
      <h1 class="display">Connecting to the <em>table</em></h1>
      <p class="lede">Loading the shared standings from Firebase…</p>
      ${cloudStatus === 'slow' ? `
        <p class="lede warn">This is taking longer than usual. Check the Firebase settings in <code>config.js</code> and your connection.</p>
        <div class="hero-actions"><button class="btn btn-ghost" data-action="use-local">Work locally for now</button></div>` : ''}
    </section>`;
  }

  /* ---------------- dashboard ---------------- */
  function renderDashboard() {
    if (!state.players.length) return emptyState();
    const stats = allStats();
    const sorted = rankStats(stats);
    const ns = nights();
    const volume = state.results.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0);
    const best = state.results.length ? state.results.reduce((m, r) => (r.amount > m.amount ? r : m)) : null;
    const worst = state.results.length ? state.results.reduce((m, r) => (r.amount < m.amount ? r : m)) : null;
    const bestPlayer = best && playerById(best.playerId);
    const worstPlayer = worst && playerById(worst.playerId);
    const top3 = sorted.filter(s => s.games).slice(0, 3);

    return `
      <section class="hero">
        <div>
          <p class="eyebrow">Season standings</p>
          <h1 class="display">Poker <em>Tracker</em></h1>
          <p class="lede">${plural(state.players.length, 'player')} · ${plural(ns.length, 'game night')} · ${fmtMoney(volume, { sign: false })} changed hands</p>
        </div>
        <div class="hero-actions">
          <a class="btn btn-primary" href="#/log">Log a game night</a>
          <button class="btn btn-ghost" data-action="open-add-player">Add player</button>
        </div>
      </section>

      ${podium(top3)}

      <section class="kpis">
        ${kpi('Game nights', ns.length, ns.length ? `Last: ${fmtDate(ns[0].date)}` : 'No games yet')}
        ${kpi('Money moved', fmtMoney(volume, { sign: false }), 'Total winnings paid out')}
        ${kpi('Biggest night', best && best.amount > 0 ? `<span class="pos">${fmtMoney(best.amount)}</span>` : '—',
              best && best.amount > 0 ? `${esc(bestPlayer ? bestPlayer.name : '?')} · ${fmtDate(best.date)}` : 'Waiting for a hero')}
        ${kpi('Worst night', worst && worst.amount < 0 ? `<span class="neg">${fmtMoney(worst.amount)}</span>` : '—',
              worst && worst.amount < 0 ? `${esc(worstPlayer ? worstPlayer.name : '?')} · ${fmtDate(worst.date)}` : 'Nobody has bled yet')}
      </section>

      <section class="grid-2">
        <div class="card">
          <div class="card-head"><h2>Leaderboard</h2><span class="hint">Ranked by net result</span></div>
          <div class="table-wrap">
            <table class="lb">
              <thead><tr>
                <th>#</th><th>Player</th><th class="num">Net</th><th class="num">Avg / game</th>
                <th class="num">Games</th><th class="num">Win %</th><th>Last 5</th>
              </tr></thead>
              <tbody>${sorted.map((s, i) => lbRow(s, i)).join('')}</tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Net profit by player</h2><span class="hint">All time</span></div>
          <div class="chart" id="net-chart"><div class="chart-tip" hidden></div></div>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Recent nights</h2><a class="link" href="#/log">Full history →</a></div>
        ${ns.length
          ? `<div class="nights">${ns.slice(0, 6).map(nightCard).join('')}</div>`
          : `<p class="empty-inline">No results yet. <a href="#/log">Log your first game night</a>.</p>`}
      </section>`;
  }

  function kpi(label, value, sub) {
    return `<div class="kpi"><p class="kpi-label">${label}</p><p class="kpi-value">${value}</p><p class="kpi-sub">${sub}</p></div>`;
  }

  /* ---- podium: top three by net result, shown 2nd · 1st · 3rd ---- */
  function podium(top) {
    if (!top.length) return '';
    const slots = [1, 0, 2].map(i => {
      const s = top[i];
      const place = i + 1;
      if (!s) return `<div class="podium-slot place-${place} empty" aria-hidden="true"></div>`;
      const p = s.player;
      return `<div class="podium-slot place-${place}">
        <div class="podium-player">
          ${place === 1 ? '<span class="crown" aria-hidden="true">👑</span>' : ''}
          <span class="avatar podium-avatar">${esc(p.emoji)}</span>
          <h3 class="podium-name" title="${esc(p.name)}">${esc(p.name)}</h3>
          <p class="podium-net ${signClass(s.net)}">${fmtMoney(s.net)}</p>
          <p class="podium-sub">${plural(s.games, 'game')} · ${Math.round(s.winRate * 100)}% wins</p>
        </div>
        <div class="podium-block"><span class="podium-rank">${place}</span></div>
      </div>`;
    });
    return `<section class="card podium" aria-label="Top three players by net result">
      <div class="card-head"><h2>Podium</h2><span class="hint">Top 3 by net result</span></div>
      <div class="podium-stage">${slots.join('')}</div>
    </section>`;
  }

  function lbRow(s, i) {
    const p = s.player;
    const rank = i + 1;
    const streak = s.last5.length
      ? s.last5.slice().reverse().map(r =>
          `<i class="dot ${signClass(r.amount)}" title="${fmtDate(r.date)}: ${fmtMoney(r.amount)}"></i>`).join('')
      : '<span class="muted">—</span>';
    return `<tr>
      <td><span class="rank ${rank <= 3 && s.games ? 'rank-' + rank : ''}">${rank}</span></td>
      <td><div class="who"><span class="avatar sm">${esc(p.emoji)}</span><span>${esc(p.name)}</span></div></td>
      <td class="num ${signClass(s.net)}">${s.games ? fmtMoney(s.net) : '—'}</td>
      <td class="num ${s.games ? signClass(s.avg) : ''}">${s.games ? fmtMoney(s.avg) : '—'}</td>
      <td class="num">${s.games}</td>
      <td class="num">${s.games ? Math.round(s.winRate * 100) + '%' : '—'}</td>
      <td><div class="streak" aria-label="Last five results">${streak}</div></td>
    </tr>`;
  }

  function nightCard(n) {
    const total = n.results.reduce((s, r) => s + r.amount, 0);
    const pot = n.results.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0);
    const off = Math.abs(total) > 0.005
      ? ` · <span class="warn" title="Results don't sum to zero">off by ${fmtMoney(total)}</span>` : '';
    return `<article class="night">
      <header>
        <div>
          <h3>${fmtDate(n.date, { weekday: 'long', month: 'short', day: 'numeric' })}</h3>
          ${n.note ? `<p class="night-note">${esc(n.note)}</p>` : ''}
        </div>
        <div class="night-meta">${plural(n.results.length, 'player')} · ${fmtMoney(pot, { sign: false })} pot${off}</div>
      </header>
      <div class="chips">${n.results.map(r => {
        const p = playerById(r.playerId);
        return `<span class="chip ${signClass(r.amount)}"><span>${esc(p ? p.emoji : '🃏')} ${esc(p ? p.name : 'Unknown')}</span><b>${fmtMoney(r.amount)}</b></span>`;
      }).join('')}</div>
    </article>`;
  }

  function emptyState() {
    return `<section class="empty">
      <div class="empty-suits" aria-hidden="true">♠ ♥ ♦ ♣</div>
      <h1 class="display">Shuffle up and <em>deal</em></h1>
      <p class="lede">Add your regulars and log each night's wins and losses.
        ${cloud ? 'Everything you enter is shared live with everyone who opens this page.'
                : 'Everything is saved in this browser and can be exported as JSON to publish on GitHub Pages.'}</p>
      <div class="hero-actions">
        <button class="btn btn-primary" data-action="open-add-player">Add first player</button>
      </div>
    </section>`;
  }

  /* ---- diverging bar chart: net profit per player ---- */
  function roundedBar(x, y, w, h, r, roundRight) {
    r = Math.min(r, w, h / 2);
    if (roundRight) {
      return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
    }
    return `M${x + w},${y} H${x + r} Q${x},${y} ${x},${y + r} V${y + h - r} Q${x},${y + h} ${x + r},${y + h} H${x + w} Z`;
  }

  function drawNetChart() {
    const wrap = document.getElementById('net-chart');
    if (!wrap) return;
    const tip = wrap.querySelector('.chart-tip');
    wrap.querySelectorAll('svg, .empty-inline').forEach(el => el.remove());

    const rows = allStats().filter(s => s.games).sort((a, b) => b.net - a.net);
    if (!rows.length) {
      wrap.insertAdjacentHTML('afterbegin', '<p class="empty-inline">Log a few results and the chart appears here.</p>');
      return;
    }

    const W = Math.max(300, wrap.clientWidth || 480);
    const narrow = W < 460;
    const labelW = narrow ? 92 : 128, valW = narrow ? 58 : 70, rowH = 36, barH = 14, padT = 6, padB = 6;
    const H = padT + rows.length * rowH + padB;
    const maxPos = Math.max(0, ...rows.map(r => r.net));
    const maxNeg = Math.max(0, ...rows.map(r => -r.net));
    const plotW = Math.max(40, W - labelW - valW * 2);
    const scale = plotW / (maxPos + maxNeg || 1);
    const x0 = labelW + valW + maxNeg * scale;

    const bars = rows.map((s, i) => {
      const y = padT + i * rowH + (rowH - barH) / 2;
      const w = Math.abs(s.net) * scale;
      const isPos = s.net >= 0;
      const x = isPos ? x0 + 1 : x0 - 1 - w;
      const lx = isPos ? x0 + w + 8 : x0 - w - 8;
      return `<g class="bar-row" data-idx="${i}">
        <rect class="hit" x="0" y="${padT + i * rowH}" width="${W}" height="${rowH}"/>
        <text class="lbl" x="${labelW - 10}" y="${y + barH / 2}" text-anchor="end" dominant-baseline="central">${esc(s.player.emoji)} ${esc(truncate(s.player.name, narrow ? 9 : 14))}</text>
        ${w > 0.5 ? `<path class="bar ${isPos ? 'pos' : 'neg'}" d="${roundedBar(x, y, w, barH, 4, isPos)}"/>` : ''}
        <text class="val" x="${lx}" y="${y + barH / 2}" text-anchor="${isPos ? 'start' : 'end'}" dominant-baseline="central">${fmtMoney(s.net)}</text>
      </g>`;
    }).join('');

    wrap.insertAdjacentHTML('afterbegin', `
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Net profit by player, all time">
        <line class="baseline" x1="${x0}" x2="${x0}" y1="${padT}" y2="${H - padB}"/>
        ${bars}
      </svg>`);

    wrap.querySelectorAll('.bar-row').forEach(g => {
      const s = rows[Number(g.dataset.idx)];
      g.addEventListener('mouseenter', () => {
        tip.innerHTML = `<strong>${esc(s.player.emoji)} ${esc(s.player.name)}</strong>
          <span>Net <b>${fmtMoney(s.net)}</b> · ${plural(s.games, 'game')}</span>
          <span>Wins <b>${Math.round(s.winRate * 100)}%</b> · avg <b>${fmtMoney(s.avg)}</b></span>
          <span>Best <b>${fmtMoney(s.best)}</b> · worst <b>${fmtMoney(s.worst)}</b></span>`;
        tip.hidden = false;
        g.classList.add('hover');
      });
      g.addEventListener('mousemove', e => {
        const r = wrap.getBoundingClientRect();
        let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
        if (x + tip.offsetWidth > r.width) x = e.clientX - r.left - tip.offsetWidth - 14;
        if (y + tip.offsetHeight > r.height + 20) y = e.clientY - r.top - tip.offsetHeight - 14;
        tip.style.transform = `translate(${Math.max(0, x)}px, ${Math.max(0, y)}px)`;
      });
      g.addEventListener('mouseleave', () => { tip.hidden = true; g.classList.remove('hover'); });
    });
  }

  /* ---------------- players ---------------- */
  function renderPlayers() {
    const stats = rankStats(allStats());
    return `
      <section class="page-head">
        <div>
          <p class="eyebrow">Roster</p>
          <h1 class="display">Players</h1>
          <p class="lede">Everyone at the table, ranked by net result. Log a result straight from a card.</p>
        </div>
        <button class="btn btn-primary" data-action="open-add-player">Add player</button>
      </section>
      ${stats.length
        ? `<div class="players-grid">${stats.map(playerCard).join('')}</div>`
        : `<div class="card empty-card"><p>No players yet.</p>
             <button class="btn btn-primary" data-action="open-add-player">Add first player</button></div>`}`;
  }

  function playerCard(s) {
    const p = s.player;
    const since = s.games ? `${plural(s.games, 'game')} · since ${fmtDate(s.results[s.results.length - 1].date, { month: 'short', year: 'numeric' })}` : 'No games yet';
    return `<article class="player-card">
      <div class="player-top">
        <span class="avatar lg">${esc(p.emoji)}</span>
        <div class="player-id"><h3>${esc(p.name)}</h3><p class="muted">${since}</p></div>
        <div class="menu">
          <button class="icon-btn" data-action="edit-player" data-id="${p.id}" title="Edit player" aria-label="Edit ${esc(p.name)}">✎</button>
          <button class="icon-btn danger" data-action="delete-player" data-id="${p.id}" title="Remove player" aria-label="Remove ${esc(p.name)}">✕</button>
        </div>
      </div>
      <div class="net-hero ${s.games ? signClass(s.net) : 'zero'}">
        <span class="net-hero-label">Net result</span>
        <span class="net-hero-value">${s.games ? fmtMoney(s.net) : '—'}</span>
      </div>
      <dl class="player-stats">
        <div><dt>Win rate</dt><dd>${s.games ? Math.round(s.winRate * 100) + '%' : '—'}</dd></div>
        <div><dt>Avg / game</dt><dd class="${s.games ? signClass(s.avg) : ''}">${s.games ? fmtMoney(s.avg) : '—'}</dd></div>
        <div><dt>Best</dt><dd class="${s.games ? signClass(s.best) : ''}">${s.games ? fmtMoney(s.best) : '—'}</dd></div>
        <div><dt>Worst</dt><dd class="${s.games ? signClass(s.worst) : ''}">${s.games ? fmtMoney(s.worst) : '—'}</dd></div>
      </dl>
      <div class="card-actions">
        <button class="btn btn-primary btn-sm" data-action="open-result" data-id="${p.id}">Log result</button>
      </div>
    </article>`;
  }

  /* ---------------- log ---------------- */
  function renderLog() {
    const players = state.players.slice().sort(byName);
    const rs = state.results.slice().sort(byDateDesc).filter(r => !historyFilter || r.playerId === historyFilter);
    return `
      <section class="page-head">
        <div>
          <p class="eyebrow">Results</p>
          <h1 class="display">Log results</h1>
          <p class="lede">Enter each player's result for the night: winners positive, losers negative. A clean table sums to zero.</p>
        </div>
      </section>
      <div class="grid-2 log-grid">
        <form class="card night-form" id="form-night" autocomplete="off" novalidate>
          <div class="card-head"><h2>Game night</h2></div>
          ${players.length ? `
            <div class="field-row">
              <label class="field"><span>Date</span><input type="date" name="date" value="${today()}" required></label>
              <label class="field grow"><span>Note <em>(optional)</em></span><input type="text" name="note" maxlength="80" placeholder="e.g. 1/2 NLH at Oleg's"></label>
            </div>
            <div class="night-rows">
              ${players.map(p => `<div class="night-row">
                <span class="avatar sm">${esc(p.emoji)}</span>
                <span class="name">${esc(p.name)}</span>
                <div class="amount"><span class="cur">${esc(cur())}</span>
                  <input type="number" step="any" name="amt-${p.id}" data-night-amt placeholder="—" inputmode="decimal" aria-label="Result for ${esc(p.name)}"></div>
              </div>`).join('')}
            </div>
            <div class="night-foot">
              <div class="balance" id="night-balance"></div>
              <button class="btn btn-primary" type="submit">Save night</button>
            </div>`
          : `<p class="empty-inline">Add players first. <a href="#/players">Go to players</a>.</p>`}
        </form>
        <div class="card">
          <div class="card-head">
            <h2>History</h2>
            <select class="select" id="history-filter" aria-label="Filter by player">
              <option value="">All players</option>
              ${players.map(p => `<option value="${p.id}" ${historyFilter === p.id ? 'selected' : ''}>${esc(p.emoji)} ${esc(p.name)}</option>`).join('')}
            </select>
          </div>
          ${rs.length ? `<div class="table-wrap"><table class="hist">
            <thead><tr><th>Date</th><th>Player</th><th class="num">Result</th><th>Note</th><th></th></tr></thead>
            <tbody>${rs.map(r => {
              const p = playerById(r.playerId);
              return `<tr>
                <td class="nowrap">${fmtDate(r.date)}</td>
                <td><div class="who"><span class="avatar xs">${esc(p ? p.emoji : '🃏')}</span>${esc(p ? p.name : 'Unknown')}</div></td>
                <td class="num ${signClass(r.amount)}">${fmtMoney(r.amount)}</td>
                <td class="note" title="${esc(r.note)}">${esc(r.note)}</td>
                <td class="num"><button class="icon-btn danger" data-action="delete-result" data-id="${r.id}" title="Delete result" aria-label="Delete result">✕</button></td>
              </tr>`;
            }).join('')}</tbody></table></div>`
          : `<p class="empty-inline">Nothing logged yet.</p>`}
        </div>
      </div>`;
  }

  function updateNightBalance() {
    const el = document.getElementById('night-balance');
    if (!el) return;
    const vals = [...document.querySelectorAll('[data-night-amt]')].map(i => parseFloat(i.value)).filter(v => !isNaN(v));
    if (!vals.length) { el.innerHTML = '<span class="muted">Fill in the players who played; leave the rest blank.</span>'; return; }
    const total = vals.reduce((s, v) => s + v, 0);
    el.innerHTML = Math.abs(total) < 0.005
      ? `<span class="ok">✓ Balanced · ${plural(vals.length, 'player')}</span>`
      : `<span class="warn">⚠ Table is off by ${fmtMoney(total)} · ${plural(vals.length, 'player')}</span>`;
  }

  /* ---------------- dialogs ---------------- */
  const $ = id => document.getElementById(id);
  const closeAll = () => document.querySelectorAll('dialog[open]').forEach(d => d.close());

  function setEmoji(form, emoji) {
    form.elements.emoji.value = emoji;
    form.querySelectorAll('#emoji-grid button').forEach(b => b.classList.toggle('on', b.dataset.emoji === emoji));
    const custom = form.querySelector('.emoji-custom');
    if (custom && EMOJIS.includes(emoji)) custom.value = '';
  }

  function openPlayerDialog(p) {
    const d = $('dlg-player'), f = $('form-player');
    f.reset();
    $('dlg-player-title').textContent = p ? 'Edit player' : 'Add player';
    f.querySelector('[type=submit]').textContent = p ? 'Save changes' : 'Add player';
    f.elements.id.value = p ? p.id : '';
    f.elements.name.value = p ? p.name : '';
    setEmoji(f, p ? p.emoji : EMOJIS[state.players.length % EMOJIS.length]);
    d.showModal();
    f.elements.name.focus();
  }

  function openResultDialog(playerId) {
    const d = $('dlg-result'), f = $('form-result');
    f.reset();
    f.elements.playerId.innerHTML = state.players.slice().sort(byName)
      .map(p => `<option value="${p.id}">${esc(p.emoji)} ${esc(p.name)}</option>`).join('');
    if (playerId) f.elements.playerId.value = playerId;
    f.elements.date.value = today();
    d.querySelectorAll('[data-cur]').forEach(el => { el.textContent = cur(); });
    d.showModal();
    f.elements.amount.focus();
  }

  function openDataDialog() {
    const d = $('dlg-data');
    $('currency-input').value = cur();
    const changed = state.updatedAt ? fmtDateTime(state.updatedAt) : 'never';
    let intro, status;
    if (cloud) {
      intro = `This page is connected to a shared Firebase table, so everyone who opens it sees the same
        standings and every change is live for all of them. Export gives you a JSON backup; Import
        replaces the shared table for everyone.`;
      status = `<div><span class="muted">Shared table:</span> <code>${esc(TABLE_ID)}</code> · <span class="ok">● live</span></div>
        <div><span class="muted">Last change:</span> ${changed}</div>`;
    } else {
      intro = `Everything is saved in this browser. To share the standings with the whole table, either
        set up a shared database (see <code>config.js</code> and the README), or export
        <code>data.json</code> and commit it next to <code>index.html</code> so visitors load it automatically.`;
      let pub;
      if (SHARED) pub = '<span class="warn">⚠ Shared table not reachable right now. Changes stay in this browser.</span>';
      else if (location.protocol === 'file:') pub = '<span class="muted">Publish check skipped: page opened as a local file.</span>';
      else if (publishedAt === null) pub = '<span class="muted">No <code>data.json</code> found next to this page yet.</span>';
      else if (state.updatedAt && state.updatedAt > publishedAt) pub = '<span class="warn">⚠ Your local data is newer than the published data.json. Export and commit it to share.</span>';
      else pub = `<span class="ok">✓ In sync with the published data.json${publishedAt ? ` (${fmtDateTime(publishedAt)})` : ''}.</span>`;
      status = `<div><span class="muted">Local copy saved:</span> ${changed}</div><div>${pub}</div>`;
    }
    $('data-intro').innerHTML = intro;
    $('sync-status').innerHTML = status;
    d.showModal();
  }

  function confirmDialog(title, msg, okLabel = 'Delete') {
    return new Promise(resolve => {
      const d = $('dlg-confirm');
      $('confirm-title').textContent = title;
      $('confirm-msg').textContent = msg;
      $('confirm-yes').textContent = okLabel;
      const onClick = e => {
        const b = e.target.closest('[data-confirm]');
        if (!b) return;
        cleanup();
        d.close();
        resolve(b.dataset.confirm === 'yes');
      };
      const onClose = () => { cleanup(); resolve(false); };
      const cleanup = () => { d.removeEventListener('click', onClick); d.removeEventListener('close', onClose); };
      d.addEventListener('click', onClick);
      d.addEventListener('close', onClose);
      d.showModal();
    });
  }

  let toastTimer;
  function toast(msg, type = 'ok') {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  /* ---------------- form handlers ---------------- */
  function savePlayer(fd) {
    const id = fd.get('id');
    const name = String(fd.get('name') || '').trim();
    const emoji = String(fd.get('emoji') || '').trim() || '🃏';
    if (!name) { toast('Name is required', 'error'); return false; }
    if (id) {
      if (!playerById(id)) return false;
      updatePlayer(id, name, emoji);
    } else {
      addPlayer(name, emoji);
    }
    return true;
  }

  function saveResult(fd) {
    const playerId = fd.get('playerId');
    const date = fd.get('date');
    const amount = parseFloat(fd.get('amount'));
    const p = playerById(playerId);
    if (!p) { toast('Pick a player', 'error'); return false; }
    if (!date) { toast('Pick a date', 'error'); return false; }
    if (isNaN(amount)) { toast('Enter a result, e.g. 120 or -80', 'error'); return false; }
    addResults([{ id: uid(), playerId, date, amount, note: '', createdAt: nowIso() }], `${fmtMoney(amount)} logged for ${p.name}`);
    return true;
  }

  function saveNight(form) {
    const fd = new FormData(form);
    const date = fd.get('date');
    const note = String(fd.get('note') || '').trim();
    if (!date) { toast('Pick a date', 'error'); return; }
    const now = nowIso();
    const entries = [];
    for (const p of state.players) {
      const raw = fd.get(`amt-${p.id}`);
      if (raw === null || String(raw).trim() === '') continue;
      const v = parseFloat(raw);
      if (!isNaN(v)) entries.push({ id: uid(), playerId: p.id, date, amount: v, note, createdAt: now });
    }
    if (!entries.length) { toast('Enter at least one result', 'error'); return; }
    const total = entries.reduce((s, e) => s + e.amount, 0);
    addResults(entries, `Night saved · ${plural(entries.length, 'result')}${Math.abs(total) > 0.005 ? ` · table off by ${fmtMoney(total)}` : ''}`);
    location.hash = '#/dashboard';
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'data.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(cloud ? 'Backup downloaded as data.json' : 'data.json downloaded. Commit it to the repo to publish.');
  }

  function importJson(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      let d;
      try { d = normalize(JSON.parse(reader.result)); } catch (e) { d = null; }
      if (!d || !d.players.length) { toast('That file is not a valid Poker Tracker export', 'error'); return; }
      const scope = cloud ? 'the shared table for everyone' : 'what is in this browser';
      if (state.players.length && !(await confirmDialog('Replace current data?', `Import ${plural(d.players.length, 'player')} and ${plural(d.results.length, 'result')}, replacing ${scope}.`, 'Import'))) return;
      replaceAll(d, `Imported ${plural(d.players.length, 'player')} and ${plural(d.results.length, 'result')}`);
      closeAll();
    };
    reader.readAsText(file);
  }

  /* ---------------- events ---------------- */
  document.addEventListener('click', async e => {
    const closer = e.target.closest('[data-close]');
    if (closer) { closer.closest('dialog').close(); return; }

    const em = e.target.closest('#emoji-grid [data-emoji]');
    if (em) { setEmoji(em.closest('form'), em.dataset.emoji); return; }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;

    switch (action) {
      case 'open-add-player': openPlayerDialog(); break;
      case 'edit-player': openPlayerDialog(playerById(id)); break;
      case 'open-result': openResultDialog(id); break;
      case 'open-data': openDataDialog(); break;
      case 'export': exportJson(); break;
      case 'import': $('file-import').click(); break;
      case 'use-local': useLocal(); break;

      case 'delete-player': {
        const p = playerById(id);
        if (!p) break;
        const n = state.results.filter(r => r.playerId === id).length;
        if (await confirmDialog(`Remove ${p.name}?`, n ? `This also deletes their ${plural(n, 'logged result')}.` : 'They have no logged results.', 'Remove player')) {
          if (historyFilter === id) historyFilter = '';
          removePlayer(id, p.name);
        }
        break;
      }
      case 'delete-result': {
        const r = state.results.find(x => x.id === id);
        if (!r) break;
        const p = playerById(r.playerId);
        if (await confirmDialog('Delete this result?', `${p ? p.name : 'Unknown'} · ${fmtDate(r.date)} · ${fmtMoney(r.amount)}`)) {
          removeResult(id);
        }
        break;
      }
      case 'reset': {
        const scope = cloud ? 'the shared table will be wiped for everyone' : 'in this browser will be deleted';
        if (await confirmDialog('Reset everything?', `All players and results ${scope}. Export first if you want a backup.`, 'Reset')) {
          historyFilter = '';
          replaceAll(blank(), 'All data cleared');
          closeAll();
        }
        break;
      }
    }
  });

  document.addEventListener('submit', e => {
    const f = e.target;
    // getAttribute: a control named "id" inside the form shadows form.id
    const id = f.getAttribute('id');
    if (id === 'form-player') { e.preventDefault(); if (savePlayer(new FormData(f))) f.closest('dialog').close(); }
    else if (id === 'form-result') { e.preventDefault(); if (saveResult(new FormData(f))) f.closest('dialog').close(); }
    else if (id === 'form-night') { e.preventDefault(); saveNight(f); }
  });

  document.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'history-filter') {
      historyFilter = t.value;
      render();
    } else if (t.id === 'currency-input') {
      const c = t.value.trim() || '$';
      t.value = c;
      setCurrency(c);
    } else if (t.id === 'file-import') {
      importJson(t.files[0]);
      t.value = '';
    }
  });

  document.addEventListener('input', e => {
    const t = e.target;
    if (t.matches('[data-night-amt]')) updateNightBalance();
    else if (t.matches('.emoji-custom')) {
      const f = t.closest('form');
      const v = t.value.trim();
      f.elements.emoji.value = v || '🃏';
      f.querySelectorAll('#emoji-grid button').forEach(b => b.classList.toggle('on', !v && b.dataset.emoji === '🃏'));
    }
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (route() === 'dashboard') drawNetChart(); }, 120);
  });
  window.addEventListener('hashchange', render);

  /* ---------------- init ---------------- */
  $('emoji-grid').innerHTML = EMOJIS.map(e => `<button type="button" data-emoji="${e}" aria-label="${e}">${e}</button>`).join('');
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
  render();
  if (SHARED) connectCloud();
  else syncFromPublished();
})();
