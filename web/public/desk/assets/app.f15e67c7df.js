
(function () {
  'use strict';
  const R = window.RIPPLE;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const arrow = d => d > 0 ? '▲' : '▼';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = d => { const [y, m, dd] = String(d).slice(0, 10).split('-'); return `${Number(dd)} ${MON[Number(m) - 1]} ${y}`; };
  const pct = v => `${Math.round(v * 100)}%`;
  const sgn = v => v == null || isNaN(v) ? '–' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}`;
  const sp1 = v => v == null || isNaN(v) ? '–' : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}%`;
  // amounts under 0.01 (a SHIB price) keep three significant digits instead of rounding to zero
  const amt = (v, loc) => Math.abs(v) > 0 && Math.abs(v) < 0.01 ? Number(v).toLocaleString(loc, { maximumSignificantDigits: 3 }) : Number(v).toLocaleString(loc, { maximumFractionDigits: v < 1 ? 4 : v < 100 ? 2 : 0 });
  const money = v => v == null ? '–' : '$' + amt(v, 'en-US');
  const inr = v => v == null ? '–' : '₹' + amt(v, 'en-IN');
  const cash = (v, ccy) => ccy === 'INR' ? inr(v) : money(v);
  // holdings: one row per account holding; the same coin in two accounts has key SYM@account
  const hname = s => String(s).replace('-USD', '').replace(/\.(NS|BO)$/, '');
  const hkey = h => h.key || h.sym;
  const usdOf = h => h.value_usd != null ? h.value_usd : (h.value || 0);
  const pxOf = h => h.price_local != null ? h.price_local : (h.trend || {}).price;
  const byValue = hs => hs.slice().sort((a, b) => usdOf(b) - usdOf(a));
  const BRK = { robinhood: 'Robinhood', groww: 'Groww', coindcx: 'CoinDCX', mf: 'Mutual funds' };
  // funds carry their AMFI name; everything else is labelled by its ticker
  const hlabel = h => h.name || hname(h.sym);
  const symLabel = s => { const h = OWN.data && OWN.data.holdings.find(x => x.sym === s); return h ? hlabel(h) : hname(s); };
  const kindTag = h => h.kind === 'fund' ? `${h.category ? h.category.toLowerCase() + ' ' : ''}fund` : (h.sector || h.kind);
  const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? String(u) : null;
  const today = () => new Date().toISOString().slice(0, 10);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function ago(ts) {
    const t = Date.parse(ts); if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 60) return `${Math.max(m, 1)} min ago`;
    const h = Math.round(m / 60); if (h < 48) return `${h} h ago`;
    return fmtDate(String(ts).slice(0, 10));
  }
  const pr = v => `<span class="${v >= 0 ? 'up' : 'down'} num">${v >= 0 ? '+' : ''}${Math.round(Math.tanh(v) * 100)}</span>`;
  const meter = v => { const w = Math.min(Math.abs(v), 1) * 50; return `<span class="meter">${v >= 0 ? `<i style="left:50%;width:${w}%;background:var(--up)"></i>` : `<i style="right:50%;width:${w}%;background:var(--down)"></i>`}</span>`; };
  function spark(series, w, h, color) {
    if (!series || series.length < 2) return '';
    const vals = series.map(p => p[1]); const lo = Math.min(...vals), hi = Math.max(...vals); const rng = hi - lo || 1;
    const X = i => 2 + i / (vals.length - 1) * (w - 6), Y = v => 3 + (1 - (v - lo) / rng) * (h - 6);
    const d = vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join('');
    const c = color || (vals[vals.length - 1] >= vals[0] ? 'var(--up)' : 'var(--down)');
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}L${X(vals.length - 1).toFixed(1)} ${h}L${X(0).toFixed(1)} ${h}Z" fill="${c}" opacity=".12"/><path d="${d}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/><circle cx="${X(vals.length - 1).toFixed(1)}" cy="${Y(vals[vals.length - 1]).toFixed(1)}" r="2.4" fill="${c}"/></svg>`;
  }

  // collapsed "More" section; data-award gives XP the first time it is opened
  const moreBox = (body, aw, meta) => body ? `<details class="more"${aw ? ` data-award="${aw}" data-meta="${esc(meta || '')}"` : ''}><summary><span class="m1">More</span><span class="m2">Less</span></summary><div class="more-body">${body}</div></details>` : '';

  // ======================= graph model =======================
  const LAYERS = ['Shocks & decisions', 'Macro & money', 'Commodities', 'Companies & sectors', 'Funds, ETFs & crypto'];
  const LAYER_SHORT = ['shock', 'macro', 'commodity', 'company', 'fund'];
  const NODES = R.nodes.map(([id, layer, label, inst, desc]) => ({ id, layer, label, inst, desc }));
  const BY = Object.fromEntries(NODES.map(n => [n.id, n]));
  const EDGES = R.edges.map(([s, t, sign, w, lag, why]) => ({ s, t, sign, w, lag, why }));
  const OUT = {}, IN = {};
  EDGES.forEach(e => { (OUT[e.s] = OUT[e.s] || []).push(e); (IN[e.t] = IN[e.t] || []).push(e); });
  const INC = R.incidents.slice().sort((a, b) => b.d.localeCompare(a.d));
  const lbl = id => (BY[id] ? BY[id].label : id);
  function incDirFor(inc, id) { if ((inc.shock || []).includes(id)) return inc.dir || 1; const m = inc.m.find(x => x[0] === id); return m ? m[1] : null; }
  function edgeEvidence(e) {
    const sup = [], con = [];
    for (const inc of INC) { const tm = inc.m.find(x => x[0] === e.t); if (!tm) continue; const sd = incDirFor(inc, e.s); if (sd === null) continue; (tm[1] === sd * e.sign ? sup : con).push(inc); }
    return { sup, con };
  }
  const MAX_DEPTH = 4, DECAY = 0.85, FLOOR = 0.03;
  function propagate(seeds) {
    const acc = {};
    const touch = id => acc[id] || (acc[id] = { pos: 0, neg: 0, best: null, seed: false });
    seeds.forEach(s => { const a = touch(s.id); a.seed = true; a.best = { v: s.dir, path: [s.id] }; });
    function walk(id, val, path) {
      if (path.length > MAX_DEPTH) return;
      for (const e of OUT[id] || []) {
        if (path.includes(e.t)) continue;
        const v = val * e.sign * e.w * (path.length > 1 ? DECAY : 1);
        if (Math.abs(v) < FLOOR) continue;
        const a = touch(e.t); if (a.seed) continue;
        if (v > 0) a.pos = 1 - (1 - a.pos) * (1 - Math.min(v, 1)); else a.neg = -(1 - (1 + a.neg) * (1 - Math.min(-v, 1)));
        const np = path.concat(e.t);
        if (!a.best || Math.abs(v) > Math.abs(a.best.v)) a.best = { v, path: np };
        walk(e.t, v, np);
      }
    }
    seeds.forEach(s => walk(s.id, s.dir, [s.id]));
    const out = [];
    for (const id in acc) {
      const a = acc[id]; if (a.seed) continue;
      const score = a.pos + a.neg, big = Math.max(a.pos, -a.neg), small = Math.min(a.pos, -a.neg);
      const mixed = small > 0.12 && small > 0.35 * big;
      if (Math.abs(score) < 0.06 && !mixed) continue;
      out.push({ id, score, path: a.best.path, mixed, pos: a.pos, neg: a.neg });
    }
    out.sort((x, y) => Math.abs(y.score) - Math.abs(x.score));
    return { list: out };
  }
  function pathText(path, seedDir) {
    let d = seedDir; const dirs = [d];
    for (let i = 1; i < path.length; i++) { const e = (OUT[path[i - 1]] || []).find(x => x.t === path[i]); d *= e ? e.sign : 1; dirs.push(d); }
    return path.map((id, i) => `${esc(lbl(id))} ${arrow(dirs[i])}`).join(' → ');
  }
  const strengthWord = v => { const a = Math.abs(v); return a >= 0.5 ? 'strong' : a >= 0.25 ? 'moderate' : 'weak'; };
  function nodeEvidence(id, dir, seeds) {
    const isShock = inc => seeds.some(s => (inc.shock || []).includes(s.id) && (inc.dir || 1) === Math.sign(s.dir));
    const same = INC.filter(inc => { const m = inc.m.find(x => x[0] === id); return m && m[1] === dir; });
    return { any: same.length, shock: same.filter(isShock).length, against: INC.filter(inc => { const m = inc.m.find(x => x[0] === id); return m && m[1] === -dir && isShock(inc); }).length };
  }

  // ======================= state =======================
  const LIVE = { feed: null, signals: null, cal: null, status: null, corr: null, prices: null };
  let CAL = {};
  const STK = { index: null, factors: null, shards: {}, current: null, factor: 'oil', db: null };
  const SCR = { data: null, group: 'all', sector: 'all' };
  const PF = { holdings: [], ref: null };
  const OWN = { data: null, open: null, acct: 'all' };
  const ME = { db: null, user: null, uid: null, owner: false };

  // ======================= game engine =======================
  const RANKS = [[1, 'Intern'], [3, 'Junior Analyst'], [5, 'Analyst'], [8, 'Senior Analyst'], [12, 'Strategist'], [17, 'Portfolio Strategist'], [23, 'Chief Economist']];
  const xpFor = lv => 60 * (lv - 1) * lv; // total XP needed to reach a level
  const levelOf = xp => { let lv = 1; while (xp >= xpFor(lv + 1)) lv++; return lv; };
  const rankOf = lv => RANKS.filter(r => lv >= r[0]).pop()[1];
  const ACTIONS = {
    event: { xp: 2, cap: 15, label: 'Read an event' }, shock: { xp: 5, cap: 8, label: 'Ran a shock' }, node: { xp: 1, cap: 15, label: 'Explored the map' },
    stock: { xp: 3, cap: 12, label: 'Opened a stock profile' }, hidden: { xp: 6, cap: 6, label: 'Found a hidden exposure' }, pair: { xp: 4, cap: 6, label: 'Tested a correlation' },
    holding: { xp: 4, cap: 12, label: 'Reviewed a holding' }, ask: { xp: 8, cap: 5, label: 'Mapped an event with Claude' }, library: { xp: 3, cap: 5, label: 'Searched the episode library' },
    screen: { xp: 3, cap: 10, label: 'Opened a screener stock' }, focus: { xp: 4, cap: 10, label: 'Researched a focus name' }, research: { xp: 5, cap: 10, label: 'Opened a research dossier' }, call: { xp: 12, cap: 6, label: 'Made a forecast call' }, pfscan: { xp: 5, cap: 2, label: 'Analysed a portfolio' },
  };
  const MISSIONS = [
    { id: 'm_focus', a: 'focus', n: 3, t: 'Research 3 names from today\u2019s focus list', icon: 'i-compass' },
    { id: 'm_research', a: 'research', n: 2, t: 'Open 2 research dossiers', icon: 'i-doc' },
    { id: 'm_ev', a: 'event', n: 3, t: 'Read 3 events on the live desk', icon: 'i-radio' },
    { id: 'm_shock', a: 'shock', n: 1, t: 'Run a shock on the knowledge graph', icon: 'i-bolt' },
    { id: 'm_hidden', a: 'hidden', n: 1, t: 'Open a stock with a hidden exposure', icon: 'i-search' },
    { id: 'm_call', a: 'call', n: 1, t: 'Make a forecast call in the Arena', icon: 'i-target' },
    { id: 'm_pair', a: 'pair', n: 1, t: 'Open a correlation test', icon: 'i-search' },
    { id: 'm_hold', a: 'holding', n: 2, t: 'Review 2 holdings in your portfolio', icon: 'i-wallet' },
    { id: 'm_screen', a: 'screen', n: 2, t: 'Open 2 stocks from the screener', icon: 'i-filter' },
    { id: 'm_lib', a: 'library', n: 1, t: 'Search the episode library', icon: 'i-book' },
    { id: 'm_node', a: 'node', n: 4, t: 'Explore 4 nodes on the knowledge graph', icon: 'i-bolt' },
  ];
  const BADGES = [
    { id: 'first_call', t: 'First call', d: 'Make a forecast call', ok: P => P.calls.length >= 1 },
    { id: 'five_calls', t: 'In the habit', d: 'Make 10 calls', ok: P => P.calls.length >= 10 },
    { id: 'calibrated', t: 'Well calibrated', d: '10 resolved calls with a Brier score under 0.23', ok: P => { const r = resolved(P); return r.length >= 10 && avg(r.map(c => c.brier)) < 0.23; } },
    { id: 'beat_model', t: 'Beat the machine', d: '5+ resolved calls scoring better than the model', ok: P => { const r = resolved(P).filter(c => c.model_brier != null); return r.length >= 5 && avg(r.map(c => c.brier)) < avg(r.map(c => c.model_brier)); } },
    { id: 'contrarian', t: 'Contrarian', d: 'Be right against the model', ok: P => resolved(P).some(c => c.right && c.model_p != null && (c.model_p >= 0.5) !== (c.dir > 0)) },
    { id: 'streak3', t: 'Three-day run', d: 'Research 3 days in a row', ok: P => streakOf(P) >= 3 },
    { id: 'streak7', t: 'Full week', d: 'Research 7 days in a row', ok: P => streakOf(P) >= 7 },
    { id: 'hidden5', t: 'Hidden-link hunter', d: 'Open 5 hidden exposures', ok: P => (P.n.hidden || 0) >= 5 },
    { id: 'shock10', t: 'Shock jockey', d: 'Run 10 shocks', ok: P => (P.n.shock || 0) >= 10 },
    { id: 'news25', t: 'News hound', d: 'Read 25 events', ok: P => (P.n.event || 0) >= 25 },
    { id: 'globe', t: 'Globetrotter', d: 'Read events from 6 regions', ok: P => (P.regions || []).length >= 6 },
    { id: 'historian', t: 'Historian', d: 'Search the library 10 times', ok: P => (P.n.library || 0) >= 10 },
    { id: 'sweep', t: 'Clean sweep', d: 'Finish all three missions in a day', ok: P => (P.sweeps || 0) >= 1 },
    { id: 'deep', t: 'Deep diver', d: 'Open 15 research dossiers', ok: P => (P.n.research || 0) >= 15 },
    { id: 'briefed', t: 'Morning briefing', d: 'Research focus names on 5 different days', ok: P => (P.focusDays || []).length >= 5 },
    { id: 'owner', t: 'Know your book', d: 'Review every holding you own', ok: P => OWN.data && OWN.data.holdings.every(h => (P.seenHold || []).includes(h.sym)) },
  ];
  const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const resolved = P => P.calls.filter(c => c.status === 'resolved');
  function streakOf(P) {
    const set = new Set(P.days || []); let n = 0; const d = new Date();
    if (!set.has(d.toISOString().slice(0, 10))) d.setUTCDate(d.getUTCDate() - 1);
    while (set.has(d.toISOString().slice(0, 10))) { n++; d.setUTCDate(d.getUTCDate() - 1); }
    return n;
  }
  const blank = () => ({ v: 1, xp: 0, n: {}, daily: { d: today(), n: {} }, days: [], badges: {}, calls: [], regions: [], sweeps: 0, seenHold: [] });
  let PROG = blank();
  const G = { ref: null, saving: false, dirty: false, timer: null, loaded: false };
  function loadLocal() { try { const d = JSON.parse(localStorage.getItem('ripple-progress') || 'null'); if (d && d.v === 1) PROG = Object.assign(blank(), d); } catch (_) {} }
  function save() {
    G.dirty = true; clearTimeout(G.timer);
    G.timer = setTimeout(async () => {
      try { localStorage.setItem('ripple-progress', JSON.stringify(PROG)); } catch (_) {}
      if (!G.ref || G.saving) return;
      G.saving = true; G.dirty = false;
      try { await G.ref.set(PROG); } catch (_) {}
      G.saving = false; if (G.dirty) save();
    }, 1200);
  }
  function rollDay() {
    if (PROG.daily.d !== today()) PROG.daily = { d: today(), n: {} };
  }
  function todaysMissions() {
    // a stable shuffle keyed on the date: the same three missions all day, different ones tomorrow
    const day = today(), key = m => { let h = 2166136261; for (const c of day + m.id) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
    return MISSIONS.filter(m => m.a !== 'holding' || OWN.data || PF.holdings.length).slice().sort((a, b) => key(a) - key(b)).slice(0, 3);
  }
  function award(action, meta) {
    const A = ACTIONS[action]; if (!A) return;
    rollDay();
    const dn = PROG.daily.n; const before = dn[action] || 0;
    dn[action] = before + 1; PROG.n[action] = (PROG.n[action] || 0) + 1;
    if (meta && meta.region && !PROG.regions.includes(meta.region)) PROG.regions.push(meta.region);
    if (meta && meta.holding && !PROG.seenHold.includes(meta.holding)) PROG.seenHold.push(meta.holding);
    if (action === 'focus') { PROG.focusDays = PROG.focusDays || []; if (!PROG.focusDays.includes(today())) PROG.focusDays = PROG.focusDays.concat(today()).slice(-60); }
    if (!PROG.days.includes(today())) { PROG.days.push(today()); PROG.days = PROG.days.slice(-120); }
    let gained = before < A.cap ? A.xp : 0; const notes = [];
    const ms = todaysMissions(); const doneBefore = PROG.daily.done || [];
    ms.forEach(m => { if (!doneBefore.includes(m.id) && (dn[m.a] || 0) >= m.n) { doneBefore.push(m.id); gained += 30; notes.push(`Mission done: ${m.t}`); } });
    PROG.daily.done = doneBefore;
    if (ms.every(m => doneBefore.includes(m.id)) && !PROG.daily.swept) { PROG.daily.swept = true; PROG.sweeps = (PROG.sweeps || 0) + 1; gained += 50; notes.push('All three missions done'); }
    gainXp(gained, notes.length ? notes[0] : A.label);
    notes.slice(1).forEach(t => toast(t, null));
    checkBadges();
    save(); renderPlayer();
  }
  function gainXp(n, label) {
    if (!n) return;
    const lv0 = levelOf(PROG.xp); PROG.xp += n; const lv1 = levelOf(PROG.xp);
    toast(label, `+${n} XP`);
    if (lv1 > lv0) toast(`Level ${lv1}: ${rankOf(lv1)}`, 'level up');
  }
  function checkBadges() {
    BADGES.forEach(b => { if (!PROG.badges[b.id]) { let ok = false; try { ok = b.ok(PROG); } catch (_) {} if (ok) { PROG.badges[b.id] = today(); PROG.xp += 40; toast(`Badge earned: ${b.t}`, '+40 XP'); } } });
  }
  function toast(text, xp) {
    const t = document.createElement('div'); t.className = 'toast';
    t.innerHTML = `<svg width="16" height="16" style="color:var(--gold)"><use href="#i-star"/></svg><span>${esc(text)}</span>${xp ? `<span class="tx">${esc(xp)}</span>` : ''}`;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), 3600);
    while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
  }
  function renderPlayer() {
    rollDay();
    const lv = levelOf(PROG.xp), lo = xpFor(lv), hi = xpFor(lv + 1), p = Math.round((PROG.xp - lo) / (hi - lo) * 100);
    const st = streakOf(PROG), nb = Object.keys(PROG.badges).length;
    $('#pLvl').textContent = lv; $('#pRank').textContent = rankOf(lv); $('#pXp').style.width = p + '%'; $('#pStreak').textContent = st;
    $('#hLvl').textContent = lv; $('#hRank').textContent = rankOf(lv); $('#hRing').style.setProperty('--p', p); $('#hXpLine').style.width = p + '%';
    $('#hXpTxt').textContent = `${PROG.xp.toLocaleString('en-US')} XP · ${hi - PROG.xp} to level ${lv + 1}`;
    $('#hStreak').textContent = st; $('#hBadges').textContent = nb;
    const nextRank = RANKS.find(r => r[0] > lv);
    $('#hNext').textContent = nextRank ? `${nextRank[1]} at level ${nextRank[0]}. Missions give 30 XP each.` : 'Top rank reached.';
    const ms = todaysMissions(); const done = PROG.daily.done || []; const dn = PROG.daily.n;
    const mh = ms.map(m => { const d = done.includes(m.id); const c = Math.min(dn[m.a] || 0, m.n); return `<div class="mission${d ? ' done' : ''}"><span class="ic"><svg width="18" height="18"><use href="#${d ? 'i-check' : m.icon}"/></svg></span><div><div class="mt">${esc(m.t)}</div><div class="bar" style="margin-top:5px"><i style="width:${c / m.n * 100}%"></i></div></div><span class="xp">${d ? 'done' : `${c}/${m.n} · 30 XP`}</span></div>`; }).join('');
    $('#missions').innerHTML = mh; $('#missions2').innerHTML = mh;
    $('#mBonus').textContent = PROG.daily.swept ? 'All done today' : '+50 XP for all three';
    renderBadges();
  }
  function renderBadges() {
    const got = Object.keys(PROG.badges).length;
    $('#badgeCount').textContent = `${got} of ${BADGES.length} earned`;
    $('#badges').innerHTML = BADGES.map(b => { const g = PROG.badges[b.id]; return `<div class="badge${g ? ' got' : ''}"><span class="medal"><svg width="22" height="22"><use href="#${g ? 'i-star' : 'i-dot'}"/></svg></span><b>${esc(b.t)}</b><span>${esc(b.d)}</span>${g ? `<span class="tag good">${esc(fmtDate(g))}</span>` : ''}</div>`; }).join('');
    $('#xpRules').innerHTML = Object.values(ACTIONS).map(a => `${esc(a.label)}: <b class="num">+${a.xp}</b> (up to ${a.cap} a day)`).join(' · ') + '. Each mission +30, all three +50, each badge +40. A resolved call earns up to +60 by how well calibrated it was.';
  }

  // ======================= router =======================
  const VIEWS = [
    ['home', 'Today', 'i-home'], ['focus', 'Focus', 'i-compass'], ['research', 'Research', 'i-doc'], ['portfolio', 'Portfolio', 'i-wallet'], ['live', 'Live desk', 'i-radio'], ['screener', 'Screener', 'i-filter'],
    ['explore', 'Explore', 'i-search'], ['graph', 'Graph', 'i-graph'], ['library', 'Library', 'i-book'], ['arena', 'Arena', 'i-target'],
  ];
  const navHtml = VIEWS.map(([k, t, ic]) => `<a href="#${k}" data-v="${k}"><svg><use href="#${ic}"/></svg><span>${t}</span>${k === 'live' ? '<span class="pip" id="pip-live" hidden></span>' : ''}</a>`).join('');
  $('#nav').innerHTML = navHtml;
  $('#mobnav').innerHTML = VIEWS.map(([k, t, ic]) => `<a href="#${k}" data-v="${k}"><svg><use href="#${ic}"/></svg>${t}</a>`).join('');
  // Desks switch in place. The page never writes to its own address: inside the viewer that write can throw or be
  // undone, so links and buttons call showView() directly and the address is only read once, at load, for deep links.
  let VIEW = 'home', PREV = null;
  const SCROLL = {};
  function route() { showView((location.hash || '').replace('#', '')); }
  function showView(v, restore) {
    const next = VIEWS.some(x => x[0] === v) ? v : 'home';
    if (next !== VIEW) { SCROLL[VIEW] = window.scrollY; PREV = VIEW; }
    VIEW = next;
    VIEWS.forEach(([k]) => { $('#v-' + k).hidden = k !== VIEW; });
    $$('.nav a, .mobnav a').forEach(a => a.setAttribute('aria-current', a.dataset.v === VIEW ? 'page' : 'false'));
    $('#where').textContent = $('#v-' + VIEW).dataset.title;
    const ma = $(`.mobnav a[data-v="${VIEW}"]`); if (ma && ma.scrollIntoView) ma.scrollIntoView({ block: 'nearest', inline: 'center' });
    if (VIEW === 'home') sizeRadar();
    if (VIEW === 'arena') renderArena();
    if (VIEW === 'graph') fgShow();
    if (VIEW === 'focus') renderFocus();
    if (VIEW === 'research') { if (!RES.key) { let last = null; try { last = localStorage.getItem('ripple-research'); } catch (_) {} if (last && ME.db) { RES.key = last; RES.kind = guessKind(last); loadDossier(); } } renderResearch(); if (RES.doc && !LV.key) liveLoad(); }
    else liveStop();
    window.scrollTo({ top: restore ? (SCROLL[VIEW] || 0) : 0, behavior: 'auto' });
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('click', ev => {
    const a = ev.target.closest && ev.target.closest('a[href^="#"]'); if (!a) return;
    const v = a.getAttribute('href').slice(1);
    if (VIEWS.some(x => x[0] === v)) { ev.preventDefault(); if (VIEW === v) window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' }); else go(v); }
  });
  const go = (v, restore) => { if (VIEW !== v) showView(v, restore); };

  // ======================= desk guide =======================
  const DESKS = {
    home: ['A one-screen summary of the day: what the news is pushing, your missions and progress, and how your holdings are being pressed.', 'Start here. Tap a highlighted asset to see why it is moving.'],
    focus: ['Today\u2019s research list: the stocks, commodities, funds and coins this week\u2019s news pushes hardest, up and down, plus your own positions.', 'Pick a few names to research. Each card shows how much other evidence agrees; open More for the details.'],
    research: ['One asset, everything gathered: what moves it, what is pushing it now, live Robinhood prices, and every source with its link.', 'Press Research on any card, or type a name at the top of the desk.'],
    portfolio: ['Your Robinhood, Groww, CoinDCX and mutual fund holdings, visible only to you: what each one moves with, what moved it in the past, and how today\u2019s news presses on it.', 'Check how concentrated you are and which events your holdings are exposed to.'],
    live: ['Every world event the two-hourly job has logged, newest first, with the assets each one hits first.', 'Catch up on what happened; filter by size or topic.'],
    screener: ['About 3,100 US and Indian stocks, ranked by how exposed they are to the last 14 days of events.', 'Find names you had not thought of; filter by market and sector.'],
    explore: ['What really moves any single stock beyond its market and sector, and whether two assets truly move together.', 'Look up a ticker, or test a pair such as copper and bitcoin.'],
    graph: ['The cause-and-effect map behind everything: 99 assets and drivers joined by 205 measured links.', 'Hover a node for details, drag it anywhere, and run a shock to watch it spread.'],
    library: ['54 past shocks since 1973 and what they moved: the evidence behind the links on the graph.', 'Search for a commodity, country or year to see what happened last time.'],
    arena: ['A forecasting game: call whether an asset rises over the next 5 trading days and see if you can beat the model.', 'Make a call a day to keep your streak, earn XP and unlock badges.'],
  };
  $('#guideList').innerHTML = VIEWS.map(([k, t, ic]) => `<div class="gitem"><span class="gi"><svg width="18" height="18" aria-hidden="true"><use href="#${ic}"/></svg></span><div class="gt"><b>${esc($('#v-' + k).dataset.title)}</b><p>${esc(DESKS[k][0])}</p><p class="muted small">${esc(DESKS[k][1])}</p><a href="#${k}" data-gclose>Open ${esc(t)}</a></div></div>`).join('');
  $('#guideMini').innerHTML = VIEWS.filter(([k]) => k !== 'home').map(([k, t]) => `<a href="#${k}"><b>${esc(t)}</b><span>${esc(DESKS[k][0])}</span></a>`).join('');
  let guideFrom = null;
  function openGuide() { guideFrom = document.activeElement; $('#guide').hidden = false; document.documentElement.style.overflow = 'hidden'; $('#guide .guide-panel').focus(); }
  function closeGuide() { if ($('#guide').hidden) return; $('#guide').hidden = true; document.documentElement.style.overflow = ''; if (guideFrom && guideFrom.focus) guideFrom.focus(); }
  $('#guideBtn').addEventListener('click', openGuide);
  $('#guideOpen2').addEventListener('click', openGuide);
  $('#guide').addEventListener('click', ev => { if (ev.target.closest('[data-gclose]')) closeGuide(); });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeGuide(); });
  let guideSeen = false; try { guideSeen = localStorage.getItem('ripple-guide-seen') === '1'; } catch (_) {}
  $('#guideCard').hidden = guideSeen;
  $('#guideGotIt').addEventListener('click', () => { $('#guideCard').hidden = true; try { localStorage.setItem('ripple-guide-seen', '1'); } catch (_) {} });

  // ======================= radar =======================
  const CATS = ['conflict', 'energy', 'metals', 'agriculture', 'trade-policy', 'sanctions', 'central-bank', 'macro-data', 'supply-chain', 'tech', 'crypto', 'corporate', 'weather', 'regulation', 'other'];
  const CAT_GROUP = { conflict: 0, sanctions: 0, energy: 1, metals: 2, agriculture: 2, weather: 2, 'trade-policy': 3, regulation: 3, 'central-bank': 4, 'macro-data': 4, 'supply-chain': 5, tech: 5, corporate: 5, crypto: 6, other: 6 };
  const GROUPS = ['Conflict', 'Energy', 'Metals & farms', 'Trade policy', 'Rates & data', 'Supply & tech', 'Crypto & other'];
  const RAD = { pts: [], t0: performance.now(), hover: null, raf: 0 };
  // theme colours, read once per theme (the radar draws every frame) and re-read when the theme changes
  const CSSV = {};
  function cssVar(n) { return CSSV[n] ??= getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function themeChanged() { for (const k in CSSV) delete CSSV[k]; if (VIEW === 'home') sizeRadar(); }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeChanged);
  window.addEventListener('mr-theme', themeChanged);
  function sizeRadar() {
    const c = $('#radar'), w = $('#radarWrap'); if (!c || !w.clientWidth) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;  // the canvas stops above the legend band
    buildRadar(); if (reduced) drawRadar(0);
  }
  function buildRadar() {
    const ev = (LIVE.feed && LIVE.feed.events) || [];
    const c = $('#radar'); const W = c.width, H = c.height; const cx = W / 2, cy = H / 2 - H * 0.03, Rm = Math.min(W, H) * 0.42;
    RAD.geo = { cx, cy, Rm, W, H };
    RAD.pts = ev.filter(e => (Date.now() - Date.parse(e.ts)) / 36e5 <= 72).map((e, i) => {
      const age = Math.max(0, (Date.now() - Date.parse(e.ts)) / 36e5);
      const g = CAT_GROUP[e.category] != null ? CAT_GROUP[e.category] : 6;
      let hh = 0; for (const ch of String(e.id || e.title)) hh = (hh * 33 + ch.charCodeAt(0)) >>> 0;
      const ang = (g / GROUPS.length) * Math.PI * 2 - Math.PI / 2 + ((hh % 1000) / 1000 - 0.5) * (Math.PI * 2 / GROUPS.length) * 0.8;
      const r = 0.12 * Rm + (age / 72) * 0.86 * Rm;
      const dir = (e.nodes || []).reduce((s, n) => s + (n.dir || 0), 0);
      return { e, x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r, s: e.scale === 'major' ? 7 : e.scale === 'notable' ? 5 : 3.4, g, age, dir };
    });
    $('#radarLegend').innerHTML = `<span><i style="background:var(--sev)"></i>major</span><span><i style="background:var(--accent)"></i>notable</span><span><i style="background:var(--muted)"></i>minor</span><span>Centre = now · edge = 72 h ago · ${RAD.pts.length} events</span>`;
  }
  function drawRadar(now) {
    const c = $('#radar'); if (!c || !RAD.geo) return; const x = c.getContext('2d'); const { cx, cy, Rm, W, H } = RAD.geo;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    x.clearRect(0, 0, W, H);
    const line = cssVar('--line'), muted = cssVar('--muted'), acc = cssVar('--accent'), down = cssVar('--sev');
    x.lineWidth = 1 * dpr;
    for (let i = 1; i <= 4; i++) { x.strokeStyle = line; x.beginPath(); x.arc(cx, cy, Rm * i / 4, 0, Math.PI * 2); x.stroke(); }
    x.font = `${10 * dpr}px ${cssVar('--mono').split(',')[0]}`; x.fillStyle = muted; x.textAlign = 'center';
    ['24h', '48h', '72h'].forEach((t, i) => x.fillText(t, cx, cy - Rm * (0.12 + 0.86 * (i + 1) / 3) + 12 * dpr));
    GROUPS.forEach((g, i) => {
      const a = (i / GROUPS.length) * Math.PI * 2 - Math.PI / 2;
      x.strokeStyle = line; x.beginPath(); x.moveTo(cx + Math.cos(a - Math.PI / GROUPS.length) * Rm * 0.12, cy + Math.sin(a - Math.PI / GROUPS.length) * Rm * 0.12); x.lineTo(cx + Math.cos(a - Math.PI / GROUPS.length) * Rm, cy + Math.sin(a - Math.PI / GROUPS.length) * Rm); x.stroke();
      x.fillStyle = muted; x.font = `600 ${10.5 * dpr}px ${cssVar('--body').split(',')[0]}`;
      const lx = cx + Math.cos(a) * (Rm + 14 * dpr), ly = cy + Math.sin(a) * (Rm + 14 * dpr);
      x.textAlign = Math.cos(a) > 0.3 ? 'left' : Math.cos(a) < -0.3 ? 'right' : 'center';
      if (lx > 4 * dpr && lx < W - 4 * dpr && ly > 10 * dpr && ly < H - 22 * dpr) x.fillText(g, lx, ly + 4 * dpr);
    });
    // ripples: three expanding rings from the centre
    if (!reduced) {
      for (let k = 0; k < 3; k++) {
        const ph = ((now / 4200) + k / 3) % 1;
        x.strokeStyle = acc; x.globalAlpha = (1 - ph) * 0.35; x.lineWidth = 2 * dpr;
        x.beginPath(); x.arc(cx, cy, Rm * ph, 0, Math.PI * 2); x.stroke();
      }
      x.globalAlpha = 1;
    }
    RAD.pts.forEach(p => {
      const col = p.e.scale === 'major' ? down : p.e.scale === 'notable' ? acc : muted;
      x.globalAlpha = 0.25 + 0.75 * (1 - p.age / 80);
      x.fillStyle = col; x.beginPath(); x.arc(p.x, p.y, p.s * dpr, 0, Math.PI * 2); x.fill();
      if (RAD.hover === p) { x.globalAlpha = 1; x.strokeStyle = cssVar('--ink'); x.lineWidth = 2 * dpr; x.beginPath(); x.arc(p.x, p.y, (p.s + 3) * dpr, 0, Math.PI * 2); x.stroke(); }
    });
    x.globalAlpha = 1;
    x.fillStyle = acc; x.beginPath(); x.arc(cx, cy, 5 * dpr, 0, Math.PI * 2); x.fill();
  }
  function loopRadar(t) { if (VIEW === 'home' && !document.hidden) drawRadar(t); RAD.raf = requestAnimationFrame(loopRadar); }
  $('#radar').addEventListener('mousemove', ev => {
    const c = $('#radar'), r = c.getBoundingClientRect(), dpr = c.width / r.width;
    const mx = (ev.clientX - r.left) * dpr, my = (ev.clientY - r.top) * dpr;
    let best = null, bd = 14 * dpr;
    RAD.pts.forEach(p => { const d = Math.hypot(p.x - mx, p.y - my); if (d < bd) { bd = d; best = p; } });
    RAD.hover = best; const tip = $('#radarTip');
    if (best) {
      if (tip.hidden || tip.dataset.cur !== best.e.id) { tip.innerHTML = `<b>${esc(best.e.title)}</b><br>${esc(ago(best.e.ts))} · ${esc(best.e.scale)} · ${esc(best.e.category || '')}`; tip.hidden = false; tip.dataset.cur = best.e.id; }
      placeTip(tip, $('#radarLead'), $('#radarWrap'), best.x / dpr, best.y / dpr, best.s + 6);
      c.style.cursor = 'pointer';
    } else { tip.hidden = true; $('#radarLead').hidden = true; tip.dataset.cur = ''; c.style.cursor = 'default'; }
    if (reduced) drawRadar(0);
  });
  $('#radar').addEventListener('mouseleave', () => { RAD.hover = null; $('#radarTip').hidden = true; $('#radarLead').hidden = true; });
  $('#radar').addEventListener('click', () => { if (RAD.hover) { const u = safeUrl(RAD.hover.e.url); award('event', { region: RAD.hover.e.region }); if (u) window.open(u, '_blank', 'noopener'); } });
  window.addEventListener('resize', () => { if (VIEW === 'home') sizeRadar(); });

  // ======================= home =======================
  function renderHome() {
    const ev = (LIVE.feed && LIVE.feed.events) || [];
    const st = LIVE.status;
    const n24 = st ? st.events_24h : ev.filter(e => Date.now() - Date.parse(e.ts) < 864e5).length;
    const major = ev.filter(e => e.scale === 'major' && Date.now() - Date.parse(e.ts) < 3 * 864e5).length;
    const prs = LIVE.signals && LIVE.signals.pressure ? Object.entries(LIVE.signals.pressure).filter(([id]) => BY[id] && BY[id].layer > 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])) : [];
    const facts = [];
    if (st) facts.push(`<span class="tag">${n24} events in 24 h</span>`);
    if (major) facts.push(`<span class="tag major">${major} major in 3 days</span>`);
    prs.slice(0, 3).forEach(([id, v]) => facts.push(`<button class="tag ${v >= 0 ? 'good' : 'bad'}" type="button" data-go="${esc(id)}" title="Open on the knowledge graph">${esc(lbl(id))} ${arrow(v)}</button>`));
    $('#heroFacts').innerHTML = facts.join('');
    if (prs[0]) $('#heroTitle').innerHTML = `Today&rsquo;s news is pushing <em>${esc(lbl(prs[0][0]))} ${prs[0][1] >= 0 ? 'up' : 'down'}</em>${prs[1] ? ` and ${esc(lbl(prs[1][0]))} ${prs[1][1] >= 0 ? 'up' : 'down'}` : ''}.`;
    $('#homeFeed').innerHTML = ev.length ? ev.slice(0, 5).map(evHtml).join('') : '<p class="empty">The newest world events appear here after the two-hourly job runs.</p>';
    renderHomeFocus(); renderHomePf();
    if (VIEW === 'home') sizeRadar();
  }
  function renderHomePf() {
    const o = OWN.data;
    if (!o) { $('#homePfBody').innerHTML = PF.holdings.length ? `<p class="small">${PF.holdings.length} tickers saved. <a href="#portfolio">See their news pressure</a>.</p>` : '<p class="empty">Your holdings appear here once they load. Only you can see them.</p>'; return; }
    const seen = new Set();
    const hs = o.holdings.slice().sort((a, b) => ((a.pressure || {}).score || 0) - ((b.pressure || {}).score || 0)).filter(h => !seen.has(h.sym) && seen.add(h.sym));
    const net = o.holdings.reduce((s, h) => s + (h.weight || 0) * ((h.pressure || {}).score || 0), 0);
    $('#homePfBody').innerHTML = `<div class="row" style="justify-content:space-between;align-items:baseline"><span><span class="fscore">${money(o.basket.value_now)}</span> <span class="muted small">${sp1(o.basket.ret_1y)} over a year</span></span><span class="small muted">news ${pr(net)}</span></div><p class="eyebrow">Most pressed by today&rsquo;s news</p>${hs.slice(0, 3).map(h => `<div class="mini-mover rowlink"><button class="symbtn" type="button" data-hold="${esc(hkey(h))}">${esc(hlabel(h))}</button>${spark(h.c, 110, 24)}${pr((h.pressure || {}).score || 0)}</div>`).join('')}`;
  }
  function evHtml(e) {
    const u = safeUrl(e.url);
    const title = u ? `<a class="ttl" href="${esc(u)}" target="_blank" rel="noopener" data-ev="${esc(e.region || '')}">${esc(e.title)}</a>` : `<span class="ttl">${esc(e.title)}</span>`;
    const nodes = (e.nodes || []).filter(n => BY[n.id]);
    const body = `${e.summary ? `<span class="sum">${esc(e.summary)}</span>` : ''}${nodes.length ? `<div class="nodes">${nodes.map(n => `<button class="nchip" type="button" data-go="${esc(n.id)}" title="${esc(n.why || '')}"><span class="${n.dir < 0 ? 'down' : 'up'}">${arrow(n.dir < 0 ? -1 : 1)}</span> ${esc(BY[n.id].label)}</button>`).join('')}</div>` : ''}<span class="muted small">${[e.region, e.category, e.source].filter(Boolean).map(esc).join(' · ')}</span>`;
    const first = nodes[0] ? `<span class="${nodes[0].dir < 0 ? 'down' : 'up'}">${arrow(nodes[0].dir < 0 ? -1 : 1)} ${esc(BY[nodes[0].id].label)}${nodes.length > 1 ? ` <span class="muted">+${nodes.length - 1}</span>` : ''}</span>` : '';
    return `<div class="li"><div class="meta"><span class="num">${esc(ago(e.ts))}</span><span class="tag ${esc(e.scale)}">${esc(e.scale)}</span>${first}</div>${title}${moreBox(body, 'event', e.region)}</div>`;
  }
  // one delegated click handler for cross-links everywhere
  document.addEventListener('click', ev => {
    const rs = ev.target.closest('[data-research]');
    if (rs) { if (rs.dataset.src === 'screen') award('screen'); if (rs.dataset.focus) award('focus'); openResearch(rs.dataset.research, rs.dataset.rkind); return; }
    const fc = ev.target.closest('[data-focus]'); if (fc) award('focus');
    const cl = ev.target.closest('[data-call]');
    if (cl) { CALL.asset = cl.dataset.call; go('arena'); renderArena(); const sel = $('#callAsset'); if (sel) sel.value = CALL.asset; renderCallContext(); return; }
    const a = ev.target.closest('[data-ev]'); if (a && a.tagName === 'A') award('event', { region: a.dataset.ev });
    const g = ev.target.closest('[data-go]');
    if (g) { if (g.dataset.ev != null) award('event', { region: g.dataset.ev }); go('graph'); select(g.dataset.go); return; }
    const s = ev.target.closest('[data-stock]');
    if (s) { if (s.dataset.src === 'screen') award('screen'); go('explore'); setEx('stocks'); $('#stockQ').value = s.dataset.stock; openStock(s.dataset.stock); return; }
    const h = ev.target.closest('[data-hold]');
    if (h) { go('portfolio'); openHolding(h.dataset.hold); }
  });
  function bindAll() { /* links are handled by the delegated listener */ }
  document.addEventListener('toggle', ev => {
    const d = ev.target;
    if (d.tagName !== 'DETAILS' || !d.open || !d.dataset.award || d.dataset.awarded) return;
    d.dataset.awarded = '1';
    const a = d.dataset.award, m = d.dataset.meta;
    award(a, a === 'event' ? { region: m } : a === 'holding' ? { holding: m } : undefined);
  }, true);

  // ======================= live desk =======================
  const FEEDF = { scale: 'all', cat: 'all', q: '', all: false };
  let sigAll = false;
  $('#scaleSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; FEEDF.scale = b.dataset.v; $$('#scaleSeg button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false')); renderLive(); });
  $('#catSel').addEventListener('change', e => { FEEDF.cat = e.target.value; renderLive(); });
  $('#feedQ').addEventListener('input', e => { FEEDF.q = e.target.value.trim().toLowerCase(); renderLive(); });
  function recentSeeds(days) {
    const ev = (LIVE.feed && LIVE.feed.events) || []; const W = { minor: 0.3, notable: 0.6, major: 1 }; const agg = {};
    ev.forEach(e => { const age = (Date.now() - Date.parse(e.ts)) / 864e5; if (!(age >= 0) || age > days) return; const mag = (W[e.scale] || 0.3) * Math.pow(0.5, age / 3); (e.nodes || []).forEach(n => { if (BY[n.id]) agg[n.id] = (agg[n.id] || 0) + (n.dir < 0 ? -1 : 1) * mag; }); });
    return Object.entries(agg).map(([id, v]) => ({ id, dir: Math.max(-1, Math.min(1, 0.5 * v)) })).filter(s => Math.abs(s.dir) >= 0.05).sort((a, b) => Math.abs(b.dir) - Math.abs(a.dir)).slice(0, 8);
  }
  $('#tracePressure').addEventListener('click', () => { const seeds = recentSeeds(7); if (seeds.length) { go('graph'); runShock('Recent world events, last 7 days', seeds, null); } });
  function renderLive() {
    const st = LIVE.status;
    const txt = st ? `Updated ${ago(st.updated)}` : 'Waiting for the job';
    $('#liveText').textContent = txt; $('#liveDot').classList.toggle('live', !!st);
    $('#railStatus').textContent = st ? `${st.events_total} events logged · refreshes every 2 hours` : 'Waiting for the first run of the job';
    if (st) { $('#liveLead').textContent = `${st.events_total} world events logged, ${st.events_24h} in the last 24 hours. Newest first, with the assets each one hits first.`; const pip = $('#pip-live'); if (pip) { pip.hidden = !st.events_24h; pip.textContent = st.events_24h; } }
    const ev = (LIVE.feed && Array.isArray(LIVE.feed.events)) ? LIVE.feed.events : [];
    const cats = [...new Set(ev.map(e => e.category).filter(Boolean))].sort();
    const cs = $('#catSel'); if (cs.options.length - 1 !== cats.length) cs.innerHTML = '<option value="all">All categories</option>' + cats.map(c => `<option value="${esc(c)}"${c === FEEDF.cat ? ' selected' : ''}>${esc(c)}</option>`).join('');
    const rows = ev.filter(e => (FEEDF.scale === 'all' || e.scale === FEEDF.scale) && (FEEDF.cat === 'all' || e.category === FEEDF.cat) && (!FEEDF.q || (e.title + ' ' + (e.summary || '') + ' ' + (e.region || '')).toLowerCase().includes(FEEDF.q)));
    if (ev.length) {
      const lim = FEEDF.all ? 80 : 12;
      $('#feed').innerHTML = (rows.length ? rows.slice(0, lim).map(evHtml).join('') : '<p class="empty">No event matches these filters.</p>') + (rows.length > 12 ? `<button class="more-btn" type="button" id="feedMore">${FEEDF.all ? 'Show fewer' : `Show all ${rows.length}`}</button>` : '');
      const fm = $('#feedMore'); if (fm) fm.addEventListener('click', () => { FEEDF.all = !FEEDF.all; renderLive(); });
    }
    const prs = LIVE.signals && LIVE.signals.pressure;
    if (prs && Object.keys(prs).length) {
      const rr = Object.entries(prs).filter(([id]) => BY[id] && BY[id].layer > 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 14);
      $('#pressure').innerHTML = rr.map(([id, v]) => `<button class="prow" type="button" data-go="${esc(id)}"><span>${esc(lbl(id))}</span>${meter(v)}<span class="pv ${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${Math.round(v * 100)}</span></button>`).join('');
      $('#tracePressure').hidden = !ev.length;
    }
    const sg = LIVE.signals;
    if (sg && sg.items) {
      const s20 = sg.summary && sg.summary.h20, s5 = sg.summary && sg.summary.h5;
      if (s20 && s5) $('#modelSummary').textContent = `${s20.with_skill} of ${s20.targets} beat naive at 20 days, ${s5.with_skill} at 5 days · median AUC ${s20.median_auc}`;
      const skillOf = r => (r.h20 && r.h20.has_skill) || (r.h5 && r.h5.has_skill) ? 1 : 0;
      const rows2 = Object.entries(sg.items).filter(([id]) => BY[id]).sort((a, b) => skillOf(b[1]) - skillOf(a[1]) || Math.abs(((b[1].h20 || {}).prob_up || 0.5) - 0.5) - Math.abs(((a[1].h20 || {}).prob_up || 0.5) - 0.5));
      const lim = sigAll ? rows2.length : 12;
      const cell = r => !r ? '<td class="num">–</td>' : `<td class="num">${r.has_skill ? `<b class="${r.prob_up >= 0.5 ? 'up' : 'down'}">${pct(r.prob_up)}</b>` : `<span class="muted">${pct(r.prob_up)}</span>`}</td>`;
      $('#signals').innerHTML = `<table><thead><tr><th>Asset</th><th>Proxy</th><th>Up in 5 d</th><th>Up in 20 d</th><th>Tested 2014–2026</th></tr></thead><tbody>${rows2.slice(0, lim).map(([id, r]) => {
        const sk = r.h20 && r.h20.has_skill ? `<span class="tag good">beat naive 20 d</span> <span class="muted small">AUC ${r.h20.auc}</span>` : r.h5 && r.h5.has_skill ? `<span class="tag good">beat naive 5 d</span> <span class="muted small">AUC ${r.h5.auc}</span>` : '<span class="tag">no proven skill</span>';
        return `<tr class="rowlink"><td><button class="linkbtn" type="button" data-go="${esc(id)}" style="color:var(--ink)">${esc(lbl(id))}</button></td><td class="num muted">${esc(r.symbol)}</td>${cell(r.h5)}${cell(r.h20)}<td>${sk}</td></tr>`;
      }).join('')}</tbody></table>${rows2.length > 12 ? `<button class="more" type="button" id="sigMore">${sigAll ? 'Show top 12' : `Show all ${rows2.length}`}</button>` : ''}`;
      const sm = $('#sigMore'); if (sm) sm.addEventListener('click', () => { sigAll = !sigAll; renderLive(); });
    }
  }

  // ======================= screener =======================
  const SGROUPS = {
    uslarge: ix => ix.includes('S&P 500'), usmid: ix => ix.includes('S&P 400') || ix.includes('S&P 600'), nasdaq: ix => ix.includes('Nasdaq'),
    inlarge: ix => ix.includes('Nifty 50') || ix.includes('Sensex'), insmall: ix => !ix.includes('Nifty 50') && !ix.includes('Sensex') && ix.some(x => x.startsWith('Nifty')), global: ix => ix.includes('Global'),
  };
  const SCRALL = { up: false, down: false };
  function renderScreen() {
    const d = SCR.data; if (!d) return;
    $('#screenAsof').textContent = `${d.events_used} events · updated ${ago(d.updated)}`;
    const all = d.up.concat(d.down); const sectors = [...new Set(all.map(r => r.sector))].sort();
    $('#scrSector').innerHTML = '<option value="all">All sectors</option>' + sectors.map(s => `<option value="${esc(s)}"${s === SCR.sector ? ' selected' : ''}>${esc(s)}</option>`).join('');
    const keep = r => (SCR.group === 'all' || SGROUPS[SCR.group](r.indexes || [])) && (SCR.sector === 'all' || r.sector === SCR.sector);
    const fl = f => (d.factors && d.factors[f]) || f;
    const item = r => {
      const s = Math.round(Math.tanh(Math.abs(r.score)) * 100);
      const body = `<span class="res-path">Through ${r.factors.map(f => `${esc(fl(f.f))} (corr ${sgn(f.rho)}, ${esc(f.cls)})`).join('; ')}</span>${r.events.length ? `<span class="res-path">${r.events.slice(0, 2).map(e => { const u = safeUrl(e.url); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title); }).join('<br>')}</span>` : ''}<span class="row" style="gap:6px"><span class="tag">${esc(r.sector)}</span><span class="tag">${esc((r.indexes || []).join(', '))}</span></span>`;
      return `<div class="res-item rowlink"><span class="res-top"><span class="res-name clamp1"><button class="symbtn" type="button" data-research="${esc(r.sym)}" data-rkind="stock" data-src="screen">${esc(r.sym)}</button> <span class="muted" style="font-weight:400">${esc(r.name)}</span></span><span class="res-str">${s}</span></span><span class="bar"><i style="width:${s}%"></i></span>${moreBox(body)}</div>`;
    };
    const col = (side, label, list) => {
      const lim = SCRALL[side] ? 25 : 8;
      return `<div class="res-col ${side === 'up' ? 'u' : 'd'}"><h4 class="${side}">${side === 'up' ? '▲' : '▼'} ${label} <span class="tag">${list.length}</span></h4>${list.slice(0, lim).map(item).join('') || '<p class="empty">None in this filter.</p>'}${list.length > 8 ? `<button class="more-btn" type="button" data-scrall="${side}">${SCRALL[side] ? 'Show fewer' : `Show all ${list.length}`}</button>` : ''}</div>`;
    };
    $('#screenCols').innerHTML = col('up', 'Exposed positively', d.up.filter(keep).slice(0, 25)) + col('down', 'Exposed negatively', d.down.filter(keep).slice(0, 25));
    $$('#screenCols [data-scrall]').forEach(b => b.addEventListener('click', () => { SCRALL[b.dataset.scrall] = !SCRALL[b.dataset.scrall]; renderScreen(); }));
  }
  $('#scrGroup').addEventListener('change', e => { SCR.group = e.target.value; renderScreen(); });
  $('#scrSector').addEventListener('change', e => { SCR.sector = e.target.value; renderScreen(); });

  // ======================= explore: stocks =======================
  function setEx(v) { $$('#exSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === v ? 'true' : 'false')); $('#ex-stocks').hidden = v !== 'stocks'; $('#ex-corr').hidden = v !== 'corr'; }
  $('#exSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setEx(b.dataset.v); });
  const fLabel = f => (STK.factors && STK.factors.factors && STK.factors.factors[f] ? STK.factors.factors[f].label : f);
  async function getProfile(sym) {
    if (!STK.index || !STK.index.stocks[sym] || !STK.db) return null;
    const key = `s${String(STK.index.stocks[sym][3]).padStart(2, '0')}`;
    if (!STK.shards[key]) { const snap = await STK.db.doc(`stocks/${key}`).get(); STK.shards[key] = snap.exists ? snap.data().profiles : {}; }
    return STK.shards[key][sym] || null;
  }
  async function openStock(sym) {
    if (!STK.index || !STK.index.stocks[sym] || !STK.db) { $('#stockCard').innerHTML = '<p class="empty">Stock profiles are still loading.</p>'; return; }
    $('#stockCard').innerHTML = '<p class="muted">Loading&hellip;</p>';
    let p = null; try { p = await getProfile(sym); } catch (e) { $('#stockCard').innerHTML = '<p class="empty">Could not load that profile. Try again in a moment.</p>'; return; }
    const first = STK.current === null; STK.current = sym;
    $('#stockCard').innerHTML = p ? stockCard(sym, p) : '<p class="empty">No profile for that stock.</p>';
    if (p && !first) { award('stock'); if ((p.exposures || []).some(x => x.hidden)) award('hidden'); }
  }
  function stockCard(sym, p) {
    const ex = p.exposures || [];
    const sens = x => x.f === 'rates' ? `${sgn(x.beta * 10)}% per 0.1 pt` : x.f === 'gpr' || x.f === 'vix' ? `${sgn(x.beta * 10)}% per 10% rise` : `${sgn(x.beta)}% per 1%`;
    const row = x => `<tr><td><b>${esc(x.label)}</b>${x.hidden ? ' <span class="tag hid">hidden</span>' : ''}</td><td>${x.cls === 'robust' ? '<span class="tag good">robust</span>' : '<span class="tag">likely</span>'}</td><td class="num ${x.rho >= 0 ? 'up' : 'down'}">${sgn(x.rho)}</td><td class="num">${sens(x)}</td></tr>`;
    const exRows = ex.length ? `<div class="tbl"><table><thead><tr><th>Also moves it</th><th>Link</th><th>Corr.</th><th>Sensitivity</th></tr></thead><tbody>${ex.slice(0, 4).map(row).join('')}</tbody></table></div>${ex.length > 4 ? moreBox(`<div class="tbl"><table><tbody>${ex.slice(4).map(row).join('')}</tbody></table></div>`) : ''}` : '<p class="empty">Nothing beyond its market and sector passed the tests: the market, its sector and company news drive it.</p>';
    const mv = (p.moves || []).map(moveHtml).join('');
    return `<div class="card-h"><p class="eyebrow">${esc(p.index)} · ${esc(p.sector)}</p><button class="btn quiet" type="button" data-research="${esc(sym)}" data-rkind="stock">Open the research dossier</button></div><h3 style="font-size:1.35rem">${esc(p.name)} <span class="muted num" style="font-size:.9rem">${esc(sym)}</span></h3>
      <p class="small muted">Moves ${p.beta_mkt}× the market${p.beta_sector != null ? ` and ${p.beta_sector}× its sector` : ''}. What else moves it, measured on what its market and sector do not explain:</p>
      ${exRows}${mv ? `<details class="more-card"><summary><h4>Its biggest surprise days since 2012</h4></summary><p class="muted small">✓ marks a same-day shock in a factor it is exposed to, in the direction that explains the move.</p><div class="list">${mv}</div></details>` : ''}`;
  }
  function moveHtml(m) {
    const fl = f => fLabel(f);
    const drv = (m.drivers || []).map(d => `<span class="nchip" title="${esc(fl(d[0]))} z ${d[2]}">${d[3] ? '✓ ' : ''}${esc(fl(d[0]))} ${sgn(d[1])}${d[0] === 'rates' ? ' pt' : '%'}</span>`).join(' ');
    const evs = (m.events || []).map(t => `<span class="muted small">• ${esc(t)}</span>`).join('<br>');
    const note = !drv && !evs && !(m.gpr_z && Math.abs(m.gpr_z) >= 2) ? '<span class="muted small">No commodity, macro or logged event that day: most likely company news (results, guidance, a deal or a ruling).</span>' : '';
    return `<div class="li"><div class="meta"><span class="num">${fmtDate(m.d)}</span><b class="${m.z >= 0 ? 'up' : 'down'} num">${m.ret != null ? sgn(m.ret) + '%' : ''}</b><span>${Math.abs(m.z)}σ beyond market${m.mkt != null ? ` · ${m.mkt_name ? esc(m.mkt_name) : 'market'} ${sgn(m.mkt)}%` : ''}</span>${m.gpr_z != null && Math.abs(m.gpr_z) >= 2 ? `<span>geopolitical risk ${sgn(m.gpr_z)}σ</span>` : ''}</div>${drv ? `<div class="nodes">${drv}</div>` : ''}${evs}${note}</div>`;
  }
  const stockRow = sym => { const s = STK.index && STK.index.stocks[sym]; return `<button class="symbtn" type="button" data-stock="${esc(sym)}">${esc(sym)}</button> <span class="muted small">${esc(s ? s[0] : '')}</span>`; };
  // a click anywhere on a row (not on a link, button, form field, or an opened "More") presses the row's main action
  const PRIMARY = '[data-research],[data-stock],[data-hold],[data-go],[data-sel]';
  document.addEventListener('click', ev => {
    const row = ev.target.closest('.rowlink'); if (!row) return;
    if (ev.target.closest('a, button, summary, input, select, textarea, label, .term, details[open] .more-body')) return;
    if (row.matches(PRIMARY)) return;
    const sel = window.getSelection && String(window.getSelection()); if (sel && sel.length > 2) return;
    const main = row.querySelector(PRIMARY); if (main) main.click();
  });
  function renderStocks() {
    const ix = STK.index, fx = STK.factors;
    if (ix && !$('#stockList').options.length) $('#stockList').innerHTML = Object.entries(ix.stocks).map(([s, v]) => `<option value="${esc(s)}">${esc(v[0])}</option>`).join('');
    if (!fx) return;
    $('#stocksAsof').textContent = `Weekly data since ${fx.since} · ${fmtDate(fx.asof)}`;
    $('#stocksLead').innerHTML = `<b>${ix ? ix.count.toLocaleString('en-US') : ''}</b> stocks tested against <b>${Object.keys(fx.factors).length}</b> factors (${fx.tests.toLocaleString('en-US')} tests): <b>${fx.counts.robust}</b> robust and <b>${fx.counts.likely}</b> likely exposures passed, where luck alone would give about ${fx.expected_false.robust} and ${fx.expected_false.likely}. <b>${fx.counts.hidden}</b> are hidden. They describe how stocks move with each factor; they do not predict next week.`;
    const fs = Object.keys(fx.by_factor || {}).sort((a, b) => fLabel(a).localeCompare(fLabel(b)));
    if (!fs.includes(STK.factor)) STK.factor = fs[0];
    $('#factorSel').innerHTML = fs.map(f => `<option value="${esc(f)}"${f === STK.factor ? ' selected' : ''}>${esc(fLabel(f))} (${fx.by_factor[f].length})</option>`).join('');
    renderFactorList();
    $('#hiddenList').innerHTML = `<table><tbody>${(fx.hidden || []).slice(0, 15).map(h => `<tr class="rowlink"><td>${stockRow(h.sym)}<br><span class="muted small">${esc(h.sector)}</span></td><td class="small">${esc(h.label)}</td><td class="num ${h.rho >= 0 ? 'up' : 'down'}">${sgn(h.rho)}</td></tr>`).join('')}</tbody></table>`;
  }
  function renderFactorList() {
    const fx = STK.factors; if (!fx) return;
    $('#factorList').innerHTML = `<table><tbody>${(fx.by_factor[STK.factor] || []).slice(0, 12).map(r => `<tr class="rowlink"><td>${stockRow(r.sym)}${r.hidden ? ' <span class="tag hid">hidden</span>' : ''}</td><td class="num ${r.rho >= 0 ? 'up' : 'down'}">${sgn(r.rho)}</td><td class="muted small">${esc(r.cls)}</td></tr>`).join('')}</tbody></table>`;
  }
  $('#factorSel').addEventListener('change', e => { STK.factor = e.target.value; renderFactorList(); });
  $('#stockQ').addEventListener('change', e => {
    const q = e.target.value.trim(); if (!STK.index || !q) return;
    const up = q.toUpperCase(); let sym = STK.index.stocks[up] ? up : null;
    if (!sym) { const hit = Object.entries(STK.index.stocks).find(([, v]) => v[0].toLowerCase().includes(q.toLowerCase())); sym = hit ? hit[0] : null; }
    if (sym) { e.target.value = sym; openStock(sym); } else $('#stockCard').innerHTML = '<p class="empty">No stock matches. Try a ticker such as XOM or a name such as Hershey.</p>';
  });

  // ======================= explore: correlations =======================
  let pairIdx = null, anyA = 'gold', anyB = 'usd';
  const strength = r => { const a = Math.abs(r || 0); return a < 0.2 ? 'weak' : a < 0.4 ? 'moderate' : 'strong'; };
  function rollChart(series) {
    if (!series || series.length < 6) return '';
    const W = 640, H = 210, L = 52, Rr = 54, T = 14, B = 28;
    const X = i => L + i / (series.length - 1) * (W - L - Rr), Y = v => T + (1 - v) / 2 * (H - T - B);
    const pts = series.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join('');
    const grid = [-1, -0.5, 0, 0.5, 1].map(v => `<line x1="${L}" x2="${W - Rr}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 0 ? 'var(--muted)' : 'var(--line)'}" stroke-width="${v === 0 ? 1 : 0.8}"/><text x="${L - 6}" y="${Y(v) + 3.5}" text-anchor="end">${sgn(v).replace('.00', '')}</text>`).join('');
    const years = []; series.forEach((p, i) => { if (p[0].endsWith('-01') && Number(p[0].slice(0, 4)) % 2 === 0) years.push(`<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${p[0].slice(0, 4)}</text>`); });
    const last = series[series.length - 1];
    return `<svg class="rc" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Rolling 26-week correlation"><rect x="${L}" y="${T}" width="${W - L - Rr}" height="${(H - T - B) / 2}" fill="var(--up-soft)" opacity="0.5"/><rect x="${L}" y="${Y(0)}" width="${W - L - Rr}" height="${(H - T - B) / 2}" fill="var(--down-soft)" opacity="0.5"/>${grid}${years.join('')}<path d="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.8"/><circle cx="${X(series.length - 1)}" cy="${Y(last[1])}" r="3.5" fill="var(--accent)"/><text x="${X(series.length - 1) + 6}" y="${Y(last[1]) + 4}" style="fill:var(--ink)">${sgn(last[1])}</text></svg>`;
  }
  function pairCard(r) {
    const A = esc(lbl(r.a)), Bn = esc(lbl(r.b)); const ll = r.lead_lag && r.lead_lag.a_leads_b_1w; const yr = r.corr_range_by_year;
    const verdict = r.predictive ? `<b>Predictive:</b> ${A}'s move this week has told you something about ${Bn}'s next week, in both halves of the sample.` : `<b>No predictive edge.</b> They move together ${strength(r.weekly_corr)}ly on the same days${r.weekly_corr_ex_spx != null && Math.abs(r.weekly_corr_ex_spx) < Math.abs(r.weekly_corr) * 0.6 ? ', mostly because both follow the stock market' : ''}, but this week's ${A} move says nothing reliable about next week's ${Bn}.`;
    return `<p class="verdict">${verdict}</p><div class="tiles">
      <div class="tile"><span class="k">Weekly correlation</span><span class="v">${sgn(r.weekly_corr)}</span><span class="s">${strength(r.weekly_corr)}</span></div>
      <div class="tile"><span class="k">After removing S&amp;P 500</span><span class="v">${sgn(r.weekly_corr_ex_spx)}</span><span class="s">without the shared market swing</span></div>
      <div class="tile"><span class="k">${A} leads by a week?</span><span class="v">${sgn(ll && ll.corr)}</span><span class="s">p = ${ll ? ll.p : '–'}</span></div></div>
      ${moreBox(`<div class="tiles pair-tiles"><div class="tile"><span class="k">Year by year</span><span class="v" style="font-size:1.2rem">${yr ? `${sgn(yr[0])} to ${sgn(yr[1])}` : '–'}</span><span class="s">sign flipped ${r.sign_flips} ${r.sign_flips === 1 ? 'time' : 'times'}</span></div><div class="tile"><span class="k">Stressed / calm</span><span class="v" style="font-size:1.2rem">${sgn(r.weekly_corr_high_vix)} / ${sgn(r.weekly_corr_low_vix)}</span><span class="s">high VIX vs low VIX weeks</span></div><div class="tile"><span class="k">${A} fell in a month</span><span class="v">${pct(r.b_down_same_month)}</span><span class="s">${Bn} fell too (usual ${pct(r.b_base_down_rate)})</span></div></div><p class="eyebrow">Correlation over the previous 26 weeks, ${esc(r.from.slice(0, 4))}–${esc(r.to.slice(0, 4))}</p>${rollChart(r.rolling26w)}`)}`;
  }
  function renderCorr() {
    const c = LIVE.corr; if (!c || !c.famous) return;
    const ex = c.experiment;
    $('#corrLead').innerHTML = `Correlation tells you what moves together; only lead-lag tells you what comes next. Of <b>${c.lead_lag_tests.toLocaleString('en-US')}</b> tests of whether one asset's weekly move predicts another's next week, <b>${c.lead_lag.length}</b> held up after correcting for running so many tests.${ex ? ` Feeding the model every asset's recent moves made it worse on unseen years: ${ex.x_beats_naive} of ${ex.targets} beat naive with them, ${ex.base_beats_naive} without.` : ''}`;
    if (pairIdx === null) pairIdx = Math.max(0, c.famous.findIndex(r => r.a === 'copper' && r.b === 'bitcoin'));
    $('#pairSel').innerHTML = c.famous.map((r, i) => `<option value="${i}"${i === pairIdx ? ' selected' : ''}>${esc(lbl(r.a))} vs ${esc(lbl(r.b))}</option>`).join('');
    $('#pairCard').innerHTML = pairCard(c.famous[pairIdx]);
    const opts = cur => c.nodes.map(n => `<option value="${esc(n)}"${n === cur ? ' selected' : ''}>${esc(lbl(n))}</option>`).join('');
    $('#anyA').innerHTML = opts(anyA); $('#anyB').innerHTML = opts(anyB);
    renderAny();
    const tp = (c.top_pairs || []).filter(p => p.ex_spx != null).sort((a, b) => Math.abs(b.ex_spx) - Math.abs(a.ex_spx)).slice(0, 12);
    $('#topPairs').innerHTML = `<table><thead><tr><th>Pair</th><th>Weekly</th><th>Ex-S&amp;P</th></tr></thead><tbody>${tp.map(p => `<tr><td class="small">${esc(lbl(p.a))} · ${esc(lbl(p.b))}</td><td class="num">${sgn(p.weekly_corr)}</td><td class="num">${sgn(p.ex_spx)}</td></tr>`).join('')}</tbody></table>`;
  }
  function renderAny() {
    const c = LIVE.corr; if (!c) return;
    const ia = c.nodes.indexOf(anyA), ib = c.nodes.indexOf(anyB); if (ia < 0 || ib < 0) return;
    if (ia === ib) { $('#anyOut').textContent = 'Pick two different assets.'; return; }
    const v = c.matrix[ia][ib]; const fi = c.famous.findIndex(r => (r.a === anyA && r.b === anyB) || (r.a === anyB && r.b === anyA));
    $('#anyOut').innerHTML = v == null ? 'Not enough overlapping history.' : `Weekly correlation since ${esc(c.since.slice(0, 4))}: <b>${sgn(v)}</b>, ${strength(v)}${v < 0 ? ' and opposite' : ''}.${fi >= 0 ? ' <button class="linkbtn" type="button" id="openPair">Open the full test</button>' : ''}`;
    const op = $('#openPair'); if (op) op.addEventListener('click', () => { pairIdx = fi; renderCorr(); award('pair'); });
  }
  $('#pairSel').addEventListener('change', e => { pairIdx = Number(e.target.value); renderCorr(); award('pair'); });
  $('#anyA').addEventListener('change', e => { anyA = e.target.value; renderAny(); });
  $('#anyB').addEventListener('change', e => { anyB = e.target.value; renderAny(); });

  // ======================= shock lab =======================
  let current = null, selected = null, showAll = { up: false, down: false };
  R.presets.forEach(p => {
    const b = document.createElement('button'); b.className = 'chip'; b.type = 'button'; b.setAttribute('aria-pressed', 'false'); b.dataset.k = p.k; b.textContent = p.label;
    b.addEventListener('click', () => { runShock(p.label, p.seeds.map(([id, dir]) => ({ id, dir })), p.k); award('shock'); });
    $('#presets').appendChild(b);
  });
  function runShock(title, seeds, key) {
    seeds = seeds.filter(s => BY[s.id]); if (!seeds.length) return;
    current = { title, seeds, result: propagate(seeds) }; showAll = { up: false, down: false };
    $$('#presets .chip').forEach(c => c.setAttribute('aria-pressed', c.dataset.k === key ? 'true' : 'false'));
    renderResults(); paintGraph();
  }
  function renderResults() {
    const box = $('#results');
    if (!current) { box.innerHTML = '<p class="empty">Pick a shock above the graph, or click a node and choose &ldquo;Run as shock&rdquo;.</p>'; return; }
    const { title, seeds, result } = current;
    const up = result.list.filter(r => !r.mixed && r.score > 0), down = result.list.filter(r => !r.mixed && r.score < 0), both = result.list.filter(r => r.mixed);
    let h = `<div class="card-h"><div><p class="eyebrow">Shock</p><h3 style="font-size:1.25rem">${esc(title)}</h3><p class="muted small">Starts at ${seeds.map(s => `${esc(lbl(s.id))} ${arrow(s.dir)}`).join(', ')} · ${result.list.length} items react within four links</p></div><button class="btn quiet" type="button" id="clearShock">Clear</button></div>`;
    h += '<div class="res-cols">' + col('up', 'Tends to rise', up) + col('down', 'Tends to fall', down) + '</div>';
    const analog = INC.filter(inc => seeds.some(s => (inc.shock || []).includes(s.id) && (inc.dir || 1) === Math.sign(s.dir))).slice(0, 6);
    const extra = [];
    if (both.length) extra.push(`<h4>Pulled both ways</h4><p class="muted small">Links push these in opposite directions; which side wins has depended on the episode.</p><div class="res-cols">${both.map(r => `<div class="res-item"><span class="res-top"><button class="linkbtn" type="button" data-sel="${r.id}" style="color:var(--ink)">${esc(lbl(r.id))}</button><span class="res-str"><span class="up">▲ ${Math.round(r.pos * 100)}</span> · <span class="down">▼ ${Math.round(-r.neg * 100)}</span></span></span><span class="res-path">Strongest path: ${pathText(r.path, (seeds.find(s => s.id === r.path[0]) || seeds[0]).dir)}</span></div>`).join('')}</div>`);
    if (analog.length) extra.push(`<h4>Past episodes of this kind of shock</h4><div class="list">${analog.map(inc => `<div class="li"><span class="meta"><span class="num">${fmtDate(inc.d)}</span></span><b>${esc(inc.t)}</b><span class="small">${inc.m.slice(0, 2).map(m => `<span class="${m[1] > 0 ? 'up' : 'down'}">${arrow(m[1])} ${esc(lbl(m[0]))}</span> ${esc(m[2])}`).join('; ')}</span></div>`).join('')}</div>`);
    if (extra.length) h += `<details class="more-card"><summary><h4>${[both.length ? `${both.length} pulled both ways` : '', analog.length ? `${analog.length} past ${analog.length === 1 ? 'episode' : 'episodes'} like this` : ''].filter(Boolean).join(' · ')}</h4></summary>${extra.join('')}</details>`;
    box.innerHTML = h;
    $('#clearShock').addEventListener('click', () => { current = null; $$('#presets .chip').forEach(c => c.setAttribute('aria-pressed', 'false')); renderResults(); paintGraph(); });
    box.querySelectorAll('[data-sel]').forEach(b => b.addEventListener('click', () => { select(b.dataset.sel); $('#kg').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' }); }));
    box.querySelectorAll('[data-side]').forEach(b => b.addEventListener('click', () => { showAll[b.dataset.side] = !showAll[b.dataset.side]; renderResults(); }));
    function col(side, label, items) {
      const lim = showAll[side] ? items.length : 6;
      let c = `<div class="res-col ${side === 'up' ? 'u' : 'd'}"><h4 class="${side}">${side === 'up' ? '▲' : '▼'} ${label} <span class="tag">${items.length}</span></h4>`;
      if (!items.length) c += '<p class="empty">Nothing on the graph.</p>';
      items.slice(0, lim).forEach(r => {
        const dir = r.score > 0 ? 1 : -1, sd = (seeds.find(s => s.id === r.path[0]) || seeds[0]).dir, ev = nodeEvidence(r.id, dir, seeds);
        const evTxt = ev.shock ? `seen in ${ev.shock} past ${ev.shock === 1 ? 'episode' : 'episodes'}` : ev.any ? `moved this way ${ev.any}×` : 'no logged episode';
        c += `<div class="res-item rowlink"><span class="res-top"><button class="linkbtn clamp1" type="button" data-sel="${r.id}" style="color:var(--ink)">${esc(lbl(r.id))}</button><span class="res-str">${strengthWord(r.score)} · ${Math.round(Math.abs(r.score) * 100)}</span></span><span class="bar"><i style="width:${Math.round(Math.abs(r.score) * 100)}%"></i></span>${moreBox(`<span class="res-path">${pathText(r.path, sd)}</span><span class="row" style="gap:6px"><span class="tag">${LAYER_SHORT[BY[r.id].layer]}</span><span class="tag">${evTxt}${ev.against ? `, ${ev.against} against` : ''}</span></span>`)}</div>`;
      });
      if (items.length > 6) c += `<button class="more-btn" type="button" data-side="${side}">${showAll[side] ? 'Show top 6' : `Show all ${items.length}`}</button>`;
      return c + '</div>';
    }
  }
  // graph
  const COLW = 236, NW = 196, NH = 24, GAP = 6, TOP = 46, LEFT = 16;
  const counts = [0, 0, 0, 0, 0]; NODES.forEach(n => counts[n.layer]++);
  const maxC = Math.max(...counts); const GW = LEFT * 2 + 4 * COLW + NW + 24, GH = TOP + maxC * (NH + GAP) + 16;
  const POS = {}; const idx = [0, 0, 0, 0, 0];
  NODES.forEach(n => { const off = (maxC - counts[n.layer]) * (NH + GAP) / 2; POS[n.id] = { x: LEFT + n.layer * COLW, y: TOP + off + idx[n.layer]++ * (NH + GAP), layer: n.layer }; });
  function edgePath(e) {
    const a = POS[e.s], b = POS[e.t]; const y1 = a.y + NH / 2, y2 = b.y + NH / 2;
    if (a.layer < b.layer) { const x1 = a.x + NW, x2 = b.x - 2, dx = (x2 - x1) / 2; return `M${x1} ${y1}C${x1 + dx} ${y1},${x2 - dx} ${y2},${x2} ${y2}`; }
    if (a.layer === b.layer) { const x = a.x + NW, bl = 22 + Math.abs(y2 - y1) * 0.14; return `M${x} ${y1}C${x + bl} ${y1},${x + bl} ${y2},${x + 2} ${y2}`; }
    const x1 = a.x, x2 = b.x + NW + 2, dx = Math.max(36, (x1 - x2) / 2); return `M${x1} ${y1}C${x1 - dx} ${y1},${x2 + dx} ${y2},${x2} ${y2}`;
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${GW} ${GH}`); svg.setAttribute('width', GW); svg.setAttribute('height', GH); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', 'Causal map of shocks, macro drivers, commodities, companies and funds');
  let inner = '<defs>' + [['same', 'mk-up'], ['opp', 'mk-down']].map(([k, c]) => `<marker id="ar-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="${c}" d="M0 0L10 5L0 10z"/></marker>`).join('') + '</defs>';
  LAYERS.forEach((l, i) => { inner += `<text class="colhead" x="${LEFT + i * COLW}" y="26">${esc(l)}</text><rect x="${LEFT + i * COLW}" y="32" width="28" height="3" rx="1.5" fill="var(--l${i})"/>`; });
  inner += '<g>' + EDGES.map((e, i) => `<path class="edge" data-i="${i}" d="${edgePath(e)}"/>`).join('') + '</g>';
  inner += '<g>' + NODES.map(n => { const p = POS[n.id]; const lab = n.label.length > 27 ? n.label.slice(0, 26) + '…' : n.label; return `<g class="node" data-id="${n.id}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${esc(n.label)}"><title>${esc(n.label)}</title><rect class="box" width="${NW}" height="${NH}" rx="7"/><rect x="0" y="0" width="4" height="${NH}" rx="2" fill="var(--l${n.layer})"/><text x="12" y="16">${esc(lab)}</text><text class="arrow" x="${NW - 8}" y="16" text-anchor="end"></text></g>`; }).join('') + '</g>';
  svg.innerHTML = inner; $('#graph').appendChild(svg);
  const edgeEls = [...svg.querySelectorAll('.edge')];
  const nodeEls = Object.fromEntries([...svg.querySelectorAll('.node')].map(g => [g.dataset.id, g]));
  Object.values(nodeEls).forEach(g => {
    g.addEventListener('click', () => { const id = g.dataset.id === selected ? null : g.dataset.id; select(id); if (id) award('node'); });
    g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(g.dataset.id === selected ? null : g.dataset.id); } });
  });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && selected) select(null); });
  function paintGraph() {
    const scores = {}, onPath = new Set(), seedSet = new Set();
    if (current) { current.seeds.forEach(s => { scores[s.id] = s.dir; seedSet.add(s.id); }); current.result.list.forEach(r => { scores[r.id] = r.score; for (let i = 1; i < r.path.length; i++) onPath.add(r.path[i - 1] + '>' + r.path[i]); }); }
    for (const id in nodeEls) {
      const g = nodeEls[id], sc = scores[id];
      g.classList.toggle('nup', sc > 0); g.classList.toggle('ndown', sc < 0); g.classList.toggle('seed', seedSet.has(id)); g.classList.toggle('sel', id === selected);
      g.querySelector('.arrow').textContent = sc ? (arrow(sc) + (seedSet.has(id) ? '' : ' ' + Math.round(Math.abs(sc) * 100))) : '';
      let faded = false;
      if (selected) faded = !(id === selected || (OUT[selected] || []).some(e => e.t === id) || (IN[selected] || []).some(e => e.s === id)); else if (current) faded = sc === undefined;
      g.classList.toggle('faded', faded);
    }
    edgeEls.forEach((p, i) => {
      const e = EDGES[i]; p.classList.remove('same', 'opp', 'dim'); p.removeAttribute('marker-end');
      const hot = selected ? (e.s === selected || e.t === selected) : current ? onPath.has(e.s + '>' + e.t) : false;
      if (hot) { const cls = !selected && current ? ((scores[e.t] || 0) > 0 ? 'same' : 'opp') : (e.sign > 0 ? 'same' : 'opp'); p.classList.add(cls); p.setAttribute('marker-end', `url(#ar-${cls})`); p.parentNode.appendChild(p); }
      else if (selected || current) p.classList.add('dim');
    });
    fgPaint(scores, onPath, seedSet);
  }
  function select(id) {
    selected = id; renderDetail(); paintGraph();
    if (id && FG.inited) fgFocus(id);
    if (id && nodeEls[id]) { const w = $('#graph'), p = POS[id]; if (w.scrollWidth > w.clientWidth) w.scrollTo({ left: Math.max(0, p.x - w.clientWidth / 2 + NW / 2) }); }
  }
  function measuredHtml(e) {
    const c = CAL[e.s + '>' + e.t]; if (!c) return '';
    if (c.verdict === 'untestable') return '<span class="measured">Measured: no market series to test</span>';
    const word = { confirmed: 'confirmed in prices', supported: 'weakly supported', unclear: 'not clear in prices', contradicted: 'contradicted by prices' }[c.verdict] || c.verdict;
    const pred = c.predictive && c.predictive !== 'none' ? ` · still predictive ${esc(c.predictive)} after the shock` : ' · no edge after the shock day';
    return `<span class="measured ${esc(c.verdict)}">Measured: ${word} · ${pct(c.hit5)} of ${c.n} shocks vs ${pct(c.base5)} base${pred}</span>`;
  }
  function modelHtml(id) {
    const s = LIVE.signals && LIVE.signals.items && LIVE.signals.items[id]; if (!s || !s.h20) return '';
    const cell = r => r ? `${pct(r.prob_up)} ${r.has_skill ? '<span class="tag good">beat naive</span>' : '<span class="tag">no proven skill</span>'}` : '–';
    return `<p class="small"><b>Model, chance of being higher:</b> 5 days ${cell(s.h5)} · 20 days ${cell(s.h20)}</p>`;
  }
  function linkHtml(e, side) {
    const other = BY[side === 'in' ? e.s : e.t]; const ev = edgeEvidence(e);
    const sg = e.sign > 0 ? '<span class="sg same">same way</span>' : '<span class="sg opp">opposite way</span>';
    const evTxt = ev.sup.length || ev.con.length ? ` · ${ev.sup.length} agree${ev.con.length ? `, ${ev.con.length} disagree` : ''}` : '';
    return `<button class="lnk" type="button" data-sel="${other.id}"><span class="lt"><b>${esc(other.label)}</b>${sg}</span><span class="muted">${esc(e.why)}</span><span class="sg" style="color:var(--muted)">weight ${e.w.toFixed(2)} · lag ${esc(e.lag)}${evTxt}</span>${measuredHtml(e)}</button>`;
  }
  function renderDetail() {
    const box = $('#detail');
    if (!selected) {
      box.innerHTML = `<p class="eyebrow">Selected node</p><h3>Nothing selected</h3><p class="empty">Click any node to see what pushes it, what it pushes, and the past episodes behind each link. Esc clears.</p><h4>Most connected</h4><div class="grid" style="gap:6px">${NODES.map(n => ({ n, c: (OUT[n.id] || []).length + (IN[n.id] || []).length })).sort((a, b) => b.c - a.c).slice(0, 5).map(({ n, c }) => `<button class="lnk" type="button" data-sel="${n.id}"><span class="lt"><b>${esc(n.label)}</b><span class="sg" style="color:var(--muted)">${c} links</span></span></button>`).join('')}</div>`;
    } else {
      const n = BY[selected]; const ins = (IN[n.id] || []).slice().sort((a, b) => b.w - a.w), outs = (OUT[n.id] || []).slice().sort((a, b) => b.w - a.w);
      const eps = INC.filter(inc => inc.m.some(m => m[0] === n.id) || (inc.shock || []).includes(n.id));
      const links = (arr, side) => arr.slice(0, 3).map(e => linkHtml(e, side)).join('') + (arr.length > 3 ? moreBox(arr.slice(3).map(e => linkHtml(e, side)).join('')) : '');
      box.innerHTML = `<p class="eyebrow">${esc(LAYERS[n.layer])}</p><h3 style="font-size:1.25rem">${esc(n.label)}</h3><p class="small">${esc(n.desc)}</p>${modelHtml(n.id)}
        <div class="row"><button class="btn up-b" type="button" id="runUp">Run as shock ▲</button><button class="btn down-b" type="button" id="runDown">Run as shock ▼</button>${n.layer >= 1 ? `<button class="btn quiet" type="button" data-research="${esc(n.id)}">Research</button>` : ''}</div>
        <h4>What moves it (${ins.length})</h4><div class="grid" style="gap:6px">${ins.length ? links(ins, 'in') : '<p class="empty">A starting shock: nothing on the graph pushes it.</p>'}</div>
        <h4>What it moves (${outs.length})</h4><div class="grid" style="gap:6px">${outs.length ? links(outs, 'out') : '<p class="empty">An end point: funds and coins that other items feed into.</p>'}</div>
        ${eps.length ? `<details class="more-card"><summary><h4>Past episodes (${eps.length})</h4></summary><div>${eps.map(inc => { const m = inc.m.find(x => x[0] === n.id); return `<div class="ep"><span class="num muted small">${fmtDate(inc.d)}</span><b>${esc(inc.t)}</b>${m ? `<span class="${m[1] > 0 ? 'up' : 'down'}">${arrow(m[1])} ${esc(m[2])}</span>` : '<span class="muted">This was the shock.</span>'}</div>`; }).join('')}<button class="more" type="button" id="toLedger">Show these in the library</button></div></details>` : ''}
        <p class="small muted"><b>Where it trades:</b> ${esc(n.inst)}</p>`;
      $('#runUp').addEventListener('click', () => { runShock(`${n.label} rises`, [{ id: n.id, dir: 1 }], null); award('shock'); });
      $('#runDown').addEventListener('click', () => { runShock(`${n.label} falls`, [{ id: n.id, dir: -1 }], null); award('shock'); });
      const tl = $('#toLedger'); if (tl) tl.addEventListener('click', () => { nodeFilter = n.id; renderLedger(); go('library'); });
    }
    box.querySelectorAll('[data-sel]').forEach(b => b.addEventListener('click', () => { select(b.dataset.sel); award('node'); }));
  }
  // ======================= floating knowledge graph =======================
  // A small force layout: nodes repel, links act as springs, and each layer is drawn gently towards its own band
  // (shocks on the left, funds and coins on the right) so cause still reads left to right. Dropped nodes stay pinned.
  const FG = { nodes: [], by: {}, links: [], alpha: 1, tx: 0, ty: 0, s: 1, w: 0, h: 0, drag: null, pan: null, hover: null, raf: 0, inited: false, fitted: false, t: 0, mode: 'float', paint: null };
  const DEG = {}; EDGES.forEach(e => { DEG[e.s] = (DEG[e.s] || 0) + 1; DEG[e.t] = (DEG[e.t] || 0) + 1; });
  const BAND = 250;
  const hash01 = (str, k) => { let h = 2166136261 ^ k; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; };
  function fgInit() {
    const box = $('#kg'); FG.w = box.clientWidth; FG.h = box.clientHeight;
    if (FG.inited || !FG.w || !FG.h) return;
    FG.inited = true;
    const NS = 'http://www.w3.org/2000/svg';
    const sv = document.createElementNS(NS, 'svg');
    sv.setAttribute('role', 'group'); sv.setAttribute('aria-label', 'Knowledge graph of shocks, macro drivers, commodities, companies and funds. Drag nodes to move them.');
    const world = document.createElementNS(NS, 'g'); const gl = document.createElementNS(NS, 'g'); const gn = document.createElementNS(NS, 'g');
    world.appendChild(gl); world.appendChild(gn); sv.appendChild(world); box.insertBefore(sv, box.firstChild);
    FG.svg = sv; FG.world = world;
    NODES.forEach(n => {
      const deg = DEG[n.id] || 0, r = 5 + Math.sqrt(deg) * 2.3;
      const p = { id: n.id, layer: n.layer, r, x: (n.layer - 2) * BAND + (hash01(n.id, 1) - 0.5) * 140, y: (hash01(n.id, 2) - 0.5) * 760, vx: 0, vy: 0, fixed: false, ph: hash01(n.id, 3) * Math.PI * 2, rx: 0, ry: 0 };
      const g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'kn' + (deg >= 7 ? ' big' : '')); g.setAttribute('tabindex', '0'); g.setAttribute('role', 'button'); g.setAttribute('aria-label', n.label);
      g.innerHTML = `<circle class="halo" r="${(r + 7).toFixed(1)}" fill="var(--l${n.layer})"/><circle class="core" r="${r.toFixed(1)}" stroke="var(--l${n.layer})"/><circle class="pin" r="2.2" cx="0" cy="0"/><text x="${(r + 6).toFixed(1)}" y="4">${esc(n.label)}</text>`;
      p.el = g; gn.appendChild(g); FG.nodes.push(p); FG.by[n.id] = p;
      g.addEventListener('pointerdown', ev => fgDown(ev, p));
      g.addEventListener('pointerenter', () => fgHover(p));
      g.addEventListener('pointerleave', () => { if (!FG.drag) fgHover(null); });
      g.addEventListener('focus', () => fgHover(p));
      g.addEventListener('blur', () => fgHover(null));
      g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(p.id === selected ? null : p.id); award('node'); } });
      g.addEventListener('dblclick', ev => { ev.stopPropagation(); if (p.fixed) { p.fixed = false; p.el.classList.remove('pinned'); FG.alpha = Math.max(FG.alpha, 0.3); fgWake(); } });
    });
    EDGES.forEach((e, i) => {
      const l = document.createElementNS(NS, 'line'); l.setAttribute('class', 'kl'); gl.appendChild(l);
      FG.links.push({ e, i, a: FG.by[e.s], b: FG.by[e.t], el: l });
    });
    for (let k = 0; k < 160; k++) fgTick();
    FG.s = Math.min(FG.w / (BAND * 5.2), FG.h / 900, 1.2); FG.tx = FG.w / 2; FG.ty = FG.h / 2;
    fgFit(true);
    sv.addEventListener('pointerdown', ev => { if (ev.target.closest('.kn')) return; FG.pan = { x: ev.clientX, y: ev.clientY, tx: FG.tx, ty: FG.ty }; sv.classList.add('panning'); sv.setPointerCapture(ev.pointerId); fgHover(null); });
    sv.addEventListener('pointermove', fgMove);
    sv.addEventListener('pointerup', fgUp); sv.addEventListener('pointercancel', fgUp);
    sv.addEventListener('wheel', ev => { if (!(ev.ctrlKey || ev.metaKey)) return; ev.preventDefault(); const r = sv.getBoundingClientRect(); fgZoom(Math.exp(-ev.deltaY * 0.01), ev.clientX - r.left, ev.clientY - r.top); }, { passive: false });
    $('#kgIn').addEventListener('click', () => fgZoom(1.25, FG.w / 2, FG.h / 2));
    $('#kgOut').addEventListener('click', () => fgZoom(0.8, FG.w / 2, FG.h / 2));
    $('#kgFit').addEventListener('click', () => fgFit(false));
    $('#kgReset').addEventListener('click', () => { FG.nodes.forEach(p => { p.fixed = false; p.el.classList.remove('pinned'); p.x = (p.layer - 2) * BAND + (Math.random() - 0.5) * 160; p.y = (Math.random() - 0.5) * 700; p.vx = p.vy = 0; }); FG.alpha = 1; FG.fitted = false; fgWake(); });
    if (window.ResizeObserver) new ResizeObserver(() => { const ow = FG.w; FG.w = box.clientWidth; FG.h = box.clientHeight; if (ow && FG.w) FG.tx += (FG.w - ow) / 2; fgDraw(); }).observe(box);
    if (FG.paint) fgPaint(...FG.paint);
    fgDraw();
  }
  function fgTick() {
    const N = FG.nodes, a = FG.alpha;
    for (let i = 0; i < N.length; i++) {
      const p = N[i];
      for (let j = i + 1; j < N.length; j++) {
        const q = N[j]; let dx = p.x - q.x, dy = p.y - q.y; let d2 = dx * dx + dy * dy;
        if (d2 > 90000) continue;
        if (d2 < 1) { dx = hash01(p.id + q.id, 4) - 0.5; dy = 0.5 - hash01(q.id + p.id, 5); d2 = 1; }
        const d = Math.sqrt(d2), f = Math.min(2900 / d2, 8) * a, fx = dx / d * f, fy = dy / d * f;
        p.vx += fx; p.vy += fy; q.vx -= fx; q.vy -= fy;
      }
    }
    FG.links.forEach(l => { const p = l.a, q = l.b; const dx = q.x - p.x, dy = q.y - p.y; const d = Math.sqrt(dx * dx + dy * dy) || 1; const k = (d - 120) * 0.01 * a * (0.4 + l.e.w); const fx = dx / d * k, fy = dy / d * k; p.vx += fx; p.vy += fy; q.vx -= fx; q.vy -= fy; });
    N.forEach(p => {
      if (p.fixed) { p.vx = p.vy = 0; return; }
      p.vx += ((p.layer - 2) * BAND - p.x) * 0.006 * a; p.vy += -p.y * 0.0022 * a;
      p.vx *= 0.82; p.vy *= 0.82;
      const v = Math.hypot(p.vx, p.vy); if (v > 24) { p.vx *= 24 / v; p.vy *= 24 / v; }
      p.x += p.vx; p.y += p.vy;
    });
    FG.alpha = Math.max(0.012, a * 0.988);
  }
  function fgDraw() {
    if (!FG.inited) return;
    const t = FG.t, float = !reduced;
    FG.nodes.forEach(p => {
      const amp = float && !p.fixed && FG.drag?.p !== p ? 3.2 : 0;
      p.rx = p.x + Math.sin(t * 0.00055 + p.ph) * amp; p.ry = p.y + Math.cos(t * 0.00047 + p.ph * 1.3) * amp;
      p.el.setAttribute('transform', `translate(${p.rx.toFixed(1)},${p.ry.toFixed(1)})`);
    });
    FG.links.forEach(l => {
      const a = l.a, b = l.b; const dx = b.rx - a.rx, dy = b.ry - a.ry, d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;
      l.el.setAttribute('x1', (a.rx + ux * (a.r + 2)).toFixed(1)); l.el.setAttribute('y1', (a.ry + uy * (a.r + 2)).toFixed(1));
      l.el.setAttribute('x2', (b.rx - ux * (b.r + 3)).toFixed(1)); l.el.setAttribute('y2', (b.ry - uy * (b.r + 3)).toFixed(1));
    });
    FG.world.setAttribute('transform', `translate(${FG.tx.toFixed(1)},${FG.ty.toFixed(1)}) scale(${FG.s.toFixed(3)})`);
    $('#kg').classList.toggle('zoomed', FG.s >= 1.35);
    if (FG.hover) fgPlaceTip(FG.hover);
  }
  function fgLoop(t) {
    FG.raf = 0;
    if (VIEW !== 'graph' || FG.mode !== 'float' || document.hidden) return;
    FG.t = t;
    const busy = FG.alpha > 0.02 || FG.drag;
    if (busy) { fgTick(); if (FG.alpha < 0.08 && !FG.fitted && !FG.drag) fgFit(true); }
    fgDraw();
    if (busy || !reduced) FG.raf = requestAnimationFrame(fgLoop);
  }
  function fgWake() { if (!FG.raf) FG.raf = requestAnimationFrame(fgLoop); }
  function fgShow() { requestAnimationFrame(() => { fgInit(); fgDraw(); fgWake(); }); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && VIEW === 'graph') fgWake(); });
  function fgWorld(ev) { const r = FG.svg.getBoundingClientRect(); return { x: (ev.clientX - r.left - FG.tx) / FG.s, y: (ev.clientY - r.top - FG.ty) / FG.s }; }
  function fgDown(ev, p) {
    ev.stopPropagation(); ev.preventDefault();
    const w = fgWorld(ev);
    FG.drag = { p, ox: p.x - w.x, oy: p.y - w.y, sx: ev.clientX, sy: ev.clientY, moved: false };
    FG.svg.setPointerCapture(ev.pointerId); p.el.classList.add('dragging');
    fgHover(p); fgWake();
  }
  function fgMove(ev) {
    if (FG.drag) {
      const d = FG.drag; if (!d.moved && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) > 4) { d.moved = true; d.p.fixed = true; d.p.el.classList.add('pinned'); }
      if (d.moved) { const w = fgWorld(ev); d.p.x = w.x + d.ox; d.p.y = w.y + d.oy; FG.alpha = Math.max(FG.alpha, 0.22); }
    } else if (FG.pan) {
      FG.tx = FG.pan.tx + ev.clientX - FG.pan.x; FG.ty = FG.pan.ty + ev.clientY - FG.pan.y; fgDraw();
    }
  }
  function fgUp() {
    if (FG.drag) {
      const d = FG.drag; d.p.el.classList.remove('dragging'); FG.drag = null;
      if (!d.moved) { const id = d.p.id === selected ? null : d.p.id; select(id); if (id) award('node'); fgHover(d.p); }
    }
    if (FG.pan) { FG.pan = null; FG.svg.classList.remove('panning'); }
    fgWake();
  }
  function fgZoom(f, px, py) { const s2 = Math.max(0.3, Math.min(3, FG.s * f)); FG.tx = px - (px - FG.tx) * (s2 / FG.s); FG.ty = py - (py - FG.ty) * (s2 / FG.s); FG.s = s2; fgDraw(); }
  function fgFit(auto) {
    if (!FG.nodes.length || !FG.w) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    FG.nodes.forEach(p => { x0 = Math.min(x0, p.x - p.r); x1 = Math.max(x1, p.x + p.r + 90); y0 = Math.min(y0, p.y - p.r); y1 = Math.max(y1, p.y + p.r); });
    const s = Math.max(0.3, Math.min(1.5, (FG.w - 40) / (x1 - x0), (FG.h - 90) / (y1 - y0)));
    FG.s = s; FG.tx = FG.w / 2 - (x0 + x1) / 2 * s; FG.ty = FG.h / 2 + 12 - (y0 + y1) / 2 * s;
    if (auto) FG.fitted = true; fgDraw();
  }
  function fgFocus(id) {
    const p = FG.by[id]; if (!p) return;
    const sx = FG.tx + p.x * FG.s, sy = FG.ty + p.y * FG.s;
    if (sx < 60 || sx > FG.w - 60 || sy < 60 || sy > FG.h - 60) { FG.tx = FG.w / 2 - p.x * FG.s; FG.ty = FG.h / 2 - p.y * FG.s; fgDraw(); }
  }
  function fgTipHtml(id) {
    const n = BY[id]; const ins = (IN[id] || []).length, outs = (OUT[id] || []).length;
    const s = LIVE.signals && LIVE.signals.items && LIVE.signals.items[id];
    const pz = LIVE.signals && LIVE.signals.pressure ? LIVE.signals.pressure[id] : null;
    const sh = current ? current.result.list.find(r => r.id === id) : null;
    const isSeed = current && current.seeds.some(x => x.id === id);
    const eps = INC.filter(inc => inc.m.some(m => m[0] === id) || (inc.shock || []).includes(id)).length;
    const pushes = (OUT[id] || []).slice().sort((a, b) => b.w - a.w).slice(0, 3).map(e => `<span class="${e.sign > 0 ? 'u' : 'dn'}">${e.sign > 0 ? '▲' : '▼'}</span> ${esc(lbl(e.t))}`).join(' · ');
    const pushedBy = (IN[id] || []).slice().sort((a, b) => b.w - a.w).slice(0, 3).map(e => esc(lbl(e.s))).join(' · ');
    const desc = String(n.desc || ''); const d = desc.length > 180 ? desc.slice(0, 178) + '…' : desc;
    return `<span class="cm">${esc(LAYERS[n.layer])} · ${esc(n.inst)}</span><span class="ct">${esc(n.label)}</span><span class="cd">${esc(d)}</span>
      <div class="cs"><span>${ins} in</span><span>${outs} out</span><span>${eps} episodes</span>${pz != null && Math.abs(pz) >= 0.01 ? `<span class="${pz >= 0 ? 'u' : 'dn'}">news ${pz >= 0 ? '+' : ''}${Math.round(pz * 100)}</span>` : ''}${s && s.h20 ? `<span>20 d up ${pct(s.h20.prob_up)}${s.h20.has_skill ? ' ✓' : ''}</span>` : ''}${isSeed ? '<span class="u">shock starts here</span>' : sh ? `<span class="${sh.score >= 0 ? 'u' : 'dn'}">shock ${sh.score >= 0 ? '▲' : '▼'} ${Math.round(Math.abs(sh.score) * 100)}</span>` : ''}</div>
      ${pushes ? `<span class="cd"><b style="color:var(--tv-ink)">Pushes</b> ${pushes}</span>` : ''}${pushedBy ? `<span class="cd"><b style="color:var(--tv-ink)">Pushed by</b> ${pushedBy}</span>` : ''}`;
  }
  function fgHover(p) {
    if (FG.hover && FG.hover !== p) FG.hover.el.classList.remove('hover');
    const tip = $('#kgTip');
    if (!p) { FG.hover = null; tip.hidden = true; tip.classList.remove('on'); $('#kgLead').hidden = true; FG.nodes.forEach(q => q.el.classList.remove('near')); return; }
    const changed = FG.hover !== p; FG.hover = p; p.el.classList.add('hover');
    const near = new Set([...(OUT[p.id] || []).map(e => e.t), ...(IN[p.id] || []).map(e => e.s)]);
    FG.nodes.forEach(q => q.el.classList.toggle('near', near.has(q.id)));
    if (changed) { tip.innerHTML = fgTipHtml(p.id); tip.hidden = false; tip.classList.remove('on'); void tip.offsetWidth; tip.classList.add('on'); }
    fgPlaceTip(p);
  }
  function fgPlaceTip(p) {
    const tip = $('#kgTip'); if (tip.hidden) return;
    // labels sit to the right of nodes, so try above and below first, then left, then right
    placeTip(tip, $('#kgLead'), $('#kg'), FG.tx + p.rx * FG.s, FG.ty + p.ry * FG.s, (p.r + 7) * FG.s + 4, 'tblr');
  }
  function fgPaint(scores, onPath, seedSet) {
    FG.paint = [scores, onPath, seedSet];
    if (!FG.inited) return;
    const nb = selected ? new Set([selected, ...(OUT[selected] || []).map(e => e.t), ...(IN[selected] || []).map(e => e.s)]) : null;
    FG.nodes.forEach(p => {
      const sc = scores[p.id], c = p.el.classList;
      c.toggle('nup', sc > 0); c.toggle('ndown', sc < 0); c.toggle('seed', seedSet.has(p.id)); c.toggle('sel', p.id === selected); c.toggle('hot', sc !== undefined && Math.abs(sc) >= 0.25);
      c.toggle('faded', nb ? !nb.has(p.id) : (current ? sc === undefined : false));
    });
    FG.links.forEach(l => {
      const e = l.e, c = l.el.classList; c.remove('same', 'opp', 'dim');
      const hot = selected ? (e.s === selected || e.t === selected) : current ? onPath.has(e.s + '>' + e.t) : false;
      if (hot) c.add(!selected && current ? ((scores[e.t] || 0) > 0 ? 'same' : 'opp') : (e.sign > 0 ? 'same' : 'opp'));
      else if (selected || current) c.add('dim');
    });
    if (FG.hover) { $('#kgTip').innerHTML = fgTipHtml(FG.hover.id); }
  }
  $('#gSeg').addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return; FG.mode = b.dataset.v;
    $$('#gSeg button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    $('#kg').hidden = FG.mode !== 'float'; $('#graph').hidden = FG.mode !== 'cols';
    if (FG.mode === 'float') fgShow();
  });

  // ask Claude
  (async function initAsk() {
    let sample = null; try { sample = window.claude && window.claude.use ? await window.claude.use('sample') : null; } catch (e) { sample = null; }
    if (!sample) return;
    const box = $('#ask'), form = $('#askForm'), input = $('#askInput'), btn = $('#askBtn'), stop = $('#askStop'), out = $('#askOut');
    box.hidden = false; let ctl = null;
    stop.addEventListener('click', () => ctl && ctl.abort());
    const nodeList = NODES.map(n => `${n.id} | ${LAYER_SHORT[n.layer]} | ${n.label}`).join('\n');
    form.addEventListener('submit', async ev => {
      ev.preventDefault(); const text = input.value.trim();
      if (!text) { out.innerHTML = '<p class="empty">Describe an event first.</p>'; return; }
      ctl = new AbortController(); btn.disabled = true; stop.hidden = false; out.innerHTML = '<p class="muted">Thinking&hellip;</p>';
      const prompt = `You map a news event onto a causal market graph used for research (not investment advice).\n\nGraph nodes (id | layer | label):\n${nodeList}\n\nEvent: "${text.replace(/"/g, "'")}"\n\nPick the 1 to 4 nodes this event hits FIRST (prefer shock, macro or commodity nodes; use only ids from the list). dir is 1 if the node rises or intensifies, -1 if it falls or eases.\nReply with only JSON in this shape:\n{"headline":"one sentence on the main channel","seeds":[{"id":"node_id","dir":1,"why":"short reason"}],"watch":["2 to 4 indicators to watch"],"analogues":[{"when":"year","event":"past event","outcome":"what moved and roughly how much"}],"blind_spot":"one hidden supply-chain link the market might miss"}\nGive up to 3 analogues; write 'approximately' when unsure of a figure.`;
      try {
        const res = await sample.json(prompt, { signal: ctl.signal });
        const seeds = (Array.isArray(res && res.seeds) ? res.seeds : []).map(s => ({ id: String(s.id), dir: Number(s.dir) < 0 ? -1 : 1, why: String(s.why || '') })).filter(s => BY[s.id]).slice(0, 4);
        if (!seeds.length) { out.innerHTML = '<p class="empty">Claude did not name any item on the map. Try describing the event more concretely.</p>'; return; }
        const list = a => (Array.isArray(a) ? a : []).slice(0, 4);
        out.innerHTML = `<div class="grid" style="gap:8px"><p><b>${esc(res.headline || text)}</b></p><p><span class="eyebrow">Hits first</span><br>${seeds.map(s => `<span class="${s.dir > 0 ? 'up' : 'down'}">${arrow(s.dir)} <b>${esc(lbl(s.id))}</b></span> <span class="muted">${esc(s.why)}</span>`).join('<br>')}</p>${list(res.watch).length ? `<p><span class="eyebrow">Watch</span><br>${list(res.watch).map(esc).join(' · ')}</p>` : ''}${list(res.analogues).length ? `<p><span class="eyebrow">Analogues suggested by Claude (check before relying)</span><br>${list(res.analogues).map(a => `<b>${esc(a.when || '')}</b> ${esc(a.event || '')}: ${esc(a.outcome || '')}`).join('<br>')}</p>` : ''}${res.blind_spot ? `<p><span class="eyebrow">Possible blind spot</span><br>${esc(res.blind_spot)}</p>` : ''}</div>`;
        runShock(text.length > 80 ? text.slice(0, 78) + '…' : text, seeds.map(s => ({ id: s.id, dir: s.dir })), null);
        award('ask');
      } catch (e) {
        const code = e && e.code;
        if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)) box.hidden = true;
        else if (code === 'cancelled') out.innerHTML = '<p class="empty">Stopped.</p>';
        else if (code === 'rate_limited') out.innerHTML = '<p class="empty">Too many requests right now. Try again in a little while.</p>';
        else if (code === 'invalid_json') out.innerHTML = '<p class="empty">Claude’s answer could not be read as a map. Press Map it to try again.</p>';
        else out.innerHTML = '<p class="empty">Could not reach Claude. Press Map it to try again.</p>';
      } finally { btn.disabled = false; stop.hidden = true; ctl = null; }
    });
  })();

  // ======================= library =======================
  let nodeFilter = null, libTimer = null;
  $('#q').addEventListener('input', () => { renderLedger(); clearTimeout(libTimer); libTimer = setTimeout(() => { if ($('#q').value.trim().length > 2) award('library'); }, 1500); });
  $('#clearNode').addEventListener('click', () => { nodeFilter = null; renderLedger(); });
  function renderLedger() {
    const q = $('#q').value.trim().toLowerCase();
    const rows = INC.filter(inc => {
      if (nodeFilter && !(inc.m.some(m => m[0] === nodeFilter) || (inc.shock || []).includes(nodeFilter))) return false;
      if (!q) return true;
      const hay = [inc.d, inc.t, inc.lesson, ...inc.m.map(m => lbl(m[0]) + ' ' + m[2]), ...(inc.shock || []).map(lbl)].join(' ').toLowerCase();
      return q.split(/\s+/).every(w => hay.includes(w));
    });
    const cn = $('#clearNode'); cn.hidden = !nodeFilter; if (nodeFilter) cn.textContent = `Only ${lbl(nodeFilter)} ×`;
    $('#histCount').textContent = `${rows.length} of ${INC.length} episodes`;
    const mv = m => `<button type="button" data-go="${m[0]}"><span class="${m[1] > 0 ? 'up' : 'down'}">${arrow(m[1])} <b>${esc(lbl(m[0]))}</b></span> <span class="muted">${esc(m[2])}</span></button>`;
    $('#ledger').innerHTML = '<div class="lrow head"><span>Date</span><span>Episode and what moved</span></div>' + (rows.length ? rows.map(inc => `<div class="lrow"><span class="num small">${fmtDate(inc.d)}</span><div class="grid" style="gap:4px;min-width:0"><div class="t">${esc(inc.t)}</div><div class="moves">${inc.m[0] ? mv(inc.m[0]) : ''}</div>${moreBox(`<span class="les">${esc(inc.lesson)}</span>${inc.m.length > 1 ? `<div class="moves">${inc.m.slice(1).map(mv).join('')}</div>` : ''}<span class="small">${inc.src === 'approx' ? '<span class="muted">Figures approximate, from the historical record</span>' : `<a href="${esc(safeUrl(inc.src) || '#')}" target="_blank" rel="noopener">Source</a>`}</span>`)}</div></div>`).join('') : '<div class="lrow"><span></span><span class="empty">No episode matches. Try a broader word.</span></div>');
  }

  // ======================= portfolio (owner report) =======================
  const PALETTE = ['var(--l1)', 'var(--l3)', 'var(--l2)', 'var(--l4)', 'var(--l0)', 'var(--accent)', 'var(--up)', 'var(--down)', 'var(--gold)', 'var(--edge)', 'var(--muted)', 'var(--ink)'];
  const short = s => String(s).replace('-USD', '');
  const CONNECT = {"groww":["Use <a href=\"/connect\">Connect investing platforms</a> at the top of this desk."],"coindcx":["Use <a href=\"/connect\">Connect investing platforms</a> at the top of this desk."],"mf":["Upload your CAMS statement on <a href=\"/connect\">Connect investing platforms</a>."]};
  function brokerCard(o) {
    const st = o.brokers || {};
    const rows = ['groww', 'coindcx', 'mf'].map(b => {
      const x = st[b] || { state: 'not_set_up' };
      const tag = x.state === 'ok' ? `<span class="tag good">${b === 'mf' && x.statement ? `statement to ${esc(x.statement)}` : `synced ${esc(ago(x.synced))}`}</span>` : x.state === 'needs_approval' ? '<span class="tag notable">approve today&rsquo;s key</span>'
        : x.state === 'needs_password' ? '<span class="tag notable">needs the PDF password</span>'
        : x.state === 'needs_token' ? '<span class="tag notable">check the key</span>' : x.state === 'error' ? '<span class="tag bad">last sync failed</span>' : '<span class="tag">not connected</span>';
      const note = x.state !== 'ok' && x.state !== 'not_set_up' && x.note ? `<p class="small muted">${esc(x.note)}${x.synced ? ` Showing the last good sync, ${esc(ago(x.synced))}.` : ''}</p>` : '';
      const skipped = (x.ignored || []).length ? `<p class="small muted">Not analysed: ${x.ignored.map(esc).join('; ')}.</p>` : '';
      const how = x.state === 'ok' ? '' : `<details class="more"><summary><span class="m1">How to connect</span><span class="m2">Hide steps</span></summary><div class="more-body"><ol class="steps">${CONNECT[b].map(t => `<li>${t}</li>`).join('')}</ol></div></details>`;
      const flagged = (x.warnings || []).length ? `<p class="small muted">The statement reader flagged ${x.warnings.length} row${x.warnings.length > 1 ? 's' : ''} to double-check against the PDF.</p>` : '';
      return `<div class="li"><div class="meta row" style="gap:8px;justify-content:space-between"><b>${BRK[b]}${b === 'mf' ? ' <span class="muted small">(CAMS statement)</span>' : ''}</b>${tag}</div>${note}${skipped}${flagged}${how}</div>`;
    }).join('');
    return `<div class="card"><div class="card-h"><h3>Connected accounts</h3><span class="eyebrow">read-only</span></div><div class="list">${rows}</div><p class="muted small">The sync can only sign in and read holdings, balances and past trades. It cannot place or cancel orders or move money, and each key is sealed so this site cannot read it back.</p></div>`;
  }
  function renderOwner() {
    const o = OWN.data, box = $('#ownerPf');
    if (!o) return;
    $('#pfAsof').textContent = `private · as of ${fmtDate(o.asof)}`;
    const accts = o.accounts || [], multi = accts.length > 1;
    if (OWN.acct !== 'all' && !accts.some(a => a.broker === OWN.acct)) OWN.acct = 'all';
    const all = byValue(o.holdings), hs = OWN.acct === 'all' ? all : all.filter(h => (h.broker || 'robinhood') === OWN.acct);
    const crypto = all.filter(h => h.kind === 'crypto').reduce((s, h) => s + (h.weight || 0), 0);
    const funds = all.filter(h => h.kind === 'fund').reduce((s, h) => s + (h.weight || 0), 0);
    const net = all.reduce((s, h) => s + (h.weight || 0) * ((h.pressure || {}).score || 0), 0);
    const lean = Object.entries(o.leaning || {}).slice(0, 8); const lmax = Math.max(0.01, ...lean.map(x => Math.abs(x[1])));
    const b = o.basket, days = b.days || [];
    const dayCard = d => `<div class="daycard"><div class="meta row" style="gap:8px"><span class="num small">${fmtDate(d.d)}</span><b class="num ${d.ret >= 0 ? 'up' : 'down'}">${sp1(d.ret)}</b><span class="muted small">S&amp;P ${d.spx == null ? '–' : sp1(d.spx)}</span></div><span class="small">From ${d.by_holding.slice(0, 3).map(x => `<b>${esc(symLabel(x[0]))}</b> <span class="${x[1] >= 0 ? 'up' : 'down'} num">${sp1(x[1])}</span>`).join(', ')}</span><span class="small muted">${d.drivers.length ? 'Same-day shocks: ' + d.drivers.map(x => `${esc(fLabel(x[0]))} ${sgn(x[1])}%`).join(', ') : 'No measured factor shock'}${d.events.length ? ' · ' + d.events.map(esc).join('; ') : ''}</span></div>`;
    const leanRow = ([f, v]) => `<div class="prow"><span>${esc(fLabel(f))}</span><span class="meter">${v >= 0 ? `<i style="left:50%;width:${Math.abs(v) / lmax * 50}%;background:var(--accent)"></i>` : `<i style="right:50%;width:${Math.abs(v) / lmax * 50}%;background:var(--accent)"></i>`}</span><span class="pv">${sgn(v)}</span></div>`;
    const acctTile = a => `<div class="tile"><span class="k">${esc(a.label)}</span><span class="v">${a.ccy === 'INR' ? inr(a.value_local) : money(a.value_usd)}</span><span class="s">${a.ccy === 'INR' ? `${money(a.value_usd)} · ` : ''}${a.count} holdings · ${pct(a.weight || 0)}</span></div>`;
    const seg = multi ? `<div class="seg" role="group" aria-label="Account">${[['all', 'All']].concat(accts.map(a => [a.broker, a.label])).map(([k, t]) => `<button type="button" data-acct="${esc(k)}" aria-pressed="${OWN.acct === k}">${esc(t)}</button>`).join('')}</div>` : '';
    const fx = o.fx && o.fx.usdinr && all.some(h => h.ccy === 'INR') ? ` · rupees counted at &#8377;${Number(o.fx.usdinr).toFixed(2)} per $` : '';
    box.innerHTML = `<div class="grid">
      <div class="tiles">
        <div class="tile"><span class="k">Value</span><span class="v">${money(b.value_now)}</span><span class="s">${all.length} holdings${multi ? ` in ${accts.length} accounts` : ''}</span></div>
        <div class="tile"><span class="k">Same basket, 1 year</span><span class="v ${b.ret_1y >= 0 ? 'up' : 'down'}">${sp1(b.ret_1y)}</span><span class="s">worst drop ${sp1(b.max_drawdown_1y)}${(b.left_out || []).length ? ` · leaves out ${b.left_out.map(s => esc(symLabel(s))).join(', ')}, listed under a year ago` : ''}</span></div>
        <div class="tile"><span class="k">Volatility</span><span class="v">${Math.round(b.vol_ann)}%</span><span class="s">a year · S&amp;P is usually 15–20%</span></div>
        <div class="tile"><span class="k">News pressure</span><span class="v">${pr(net)}</span><span class="s">last 14 days</span></div>
      </div>
      ${multi ? `<div class="tiles">${accts.map(acctTile).join('')}</div>` : ''}
      <div class="card"><div class="card-h"><h3>Holdings</h3>${seg}</div>
        <p class="muted small">${pct(crypto)} crypto · ${pct(1 - crypto - funds)} stocks${funds ? ` · ${pct(funds)} mutual funds` : ''}${fx} · tap a row for details</p>
        <div class="alloc">${hs.map((h, i) => `<i style="width:${(h.weight || 0) * 100}%;background:${PALETTE[i % PALETTE.length]}" title="${esc(hlabel(h))} ${pct(h.weight || 0)}"></i>`).join('')}</div>
        <div class="tbl"><table><thead><tr><th>Holding</th><th>40 days</th><th>Value</th><th>vs your cost</th><th>News now</th></tr></thead><tbody>${hs.map((h, i) => {
          const t = h.trend || {}, pz = (h.pressure || {}).score || 0, vc = t.vs_cost;
          return `<tr class="click" data-hold="${esc(hkey(h))}"><td><span class="row" style="gap:8px;flex-wrap:nowrap"><i style="width:10px;height:10px;border-radius:3px;display:inline-block;background:${PALETTE[i % PALETTE.length]}"></i><b class="${h.kind === 'fund' ? 'fundname' : 'num'}">${esc(hlabel(h))}</b>${multi && OWN.acct === 'all' ? `<span class="tag">${esc(BRK[h.broker] || 'Robinhood')}</span>` : ''}</span></td><td>${spark(h.c, 96, 26)}</td><td class="num">${cash(h.value, h.ccy)} <span class="muted small">${pct(h.weight || 0)}</span></td><td class="num ${vc == null ? 'muted' : vc >= 0 ? 'up' : 'down'}"${h.cost_note ? ` title="${esc(h.cost_note)}"` : ''}>${vc == null ? 'unknown' : sp1(vc)}</td><td>${pr(pz)}</td></tr>`;
        }).join('')}</tbody></table></div>
        <div id="holdDetail"></div>
      </div>
      <div class="grid g2">
        <div class="card"><div class="card-h"><h3>What it leans on</h3><span class="eyebrow">beyond the market</span></div>${lean.slice(0, 3).map(leanRow).join('') || '<p class="empty">No measured exposures.</p>'}${lean.length > 3 ? moreBox(lean.slice(3).map(leanRow).join('')) : ''}</div>
        <div class="card"><div class="card-h"><h3>Biggest days, last year</h3><span class="eyebrow">and what drove them</span></div><div class="grid" style="gap:8px">${days.slice(0, 2).map(dayCard).join('')}</div>${days.length > 2 ? moreBox(`<div class="grid" style="gap:8px">${days.slice(2).map(dayCard).join('')}</div>`) : ''}</div>
      </div>
      ${brokerCard(o)}</div>`;
    if (OWN.open) openHolding(OWN.open, true);
  }
  $('#ownerPf').addEventListener('click', ev => { const t = ev.target.closest('[data-acct]'); if (!t) return; OWN.acct = t.dataset.acct; OWN.open = null; renderOwner(); });
  function openHolding(key, quiet) {
    const o = OWN.data; if (!o) return;
    const h = o.holdings.find(x => hkey(x) === key) || o.holdings.find(x => x.sym === key || short(x.sym) === key || hname(x.sym) === key); const box = $('#holdDetail'); if (!h || !box) return;
    if (OWN.acct !== 'all' && (h.broker || 'robinhood') !== OWN.acct) { OWN.acct = 'all'; OWN.open = hkey(h); renderOwner(); return; }
    OWN.open = hkey(h);
    const t = h.trend || {}, b = h.betas || {}, p = h.pressure || {};
    const bt = (k, n) => b[k] ? `<div class="tile"><span class="k">${n}</span><span class="v" style="font-size:1.25rem">${sgn(b[k].corr)}</span><span class="s">correlation, 3 years weekly</span></div>` : '';
    const od = hz => { const r = (h.odds || {})[hz]; return r ? `<div class="tile"><span class="k">Up in ${hz === 'h5' ? 5 : 20} days</span><span class="v" style="font-size:1.25rem">${pct(r.prob_up)}</span><span class="s">${r.has_skill ? 'beat naive in testing' : 'no edge in testing'}</span></div>` : ''; };
    const evRow = e => { const u = safeUrl(e.url); return `<div class="li"><div class="meta"><span class="num">${esc(ago(e.ts))}</span>${pr(e.c)}</div>${u ? `<a class="ttl" href="${esc(u)}" target="_blank" rel="noopener" data-ev="">${esc(e.title)}</a>` : `<span class="ttl">${esc(e.title)}</span>`}</div>`; };
    const evs = p.events || [];
    // name the strongest link: a clear factor exposure, else its market when it tracks it closely, else bitcoin
    const ex = (h.exposures || [])[0], mk = b.nifty && b.nifty.corr > 0.5 ? `the Nifty 50 (${sgn(b.nifty.corr)})` : b.sp500 && b.sp500.corr > 0.5 ? `the S&P 500 (${sgn(b.sp500.corr)})` : null;
    const lead = ex && Math.abs(ex.rho) >= 0.3 ? `${esc(ex.label)} (${sgn(ex.rho)})` : mk || (ex ? `${esc(ex.label)} (${sgn(ex.rho)})` : b.bitcoin && b.bitcoin.corr > 0.5 ? `bitcoin (${sgn(b.bitcoin.corr)})` : 'the market and company news');
    box.innerHTML = `<div class="card flat drawer" style="margin-top:12px"><div class="card-h"><h3 style="font-size:1.25rem">${esc(hlabel(h))} <span class="tag">${esc(kindTag(h))}</span>${h.broker && h.broker !== 'robinhood' ? ` <span class="tag">${esc(BRK[h.broker])}</span>` : ''}</h3><span class="row" style="gap:6px">${h.kind === 'fund' ? '' : `<button class="btn quiet" type="button" data-research="${esc(short(h.sym))}" data-rkind="${esc(h.kind)}">Research</button>`}<button class="btn quiet" type="button" id="holdClose">Close</button></span></div>
      <div class="row" style="align-items:end">${spark(h.c, 320, 64)}<div class="small"><b>${cash(pxOf(h), h.ccy)}</b> <span class="muted">· ${sp1(t.drawdown_1y)} from its 1-year high · mostly moves with ${lead}</span></div></div>
      ${h.cost_note ? `<p class="muted small">${esc(h.cost_note)}</p>` : ''}
      ${h.local_premium != null && Math.abs(h.local_premium) >= 1 ? `<p class="muted small">CoinDCX&rsquo;s rupee price is ${Math.abs(h.local_premium).toFixed(1)}% ${h.local_premium > 0 ? 'above' : 'below'} the world price at today&rsquo;s exchange rate, as on most Indian exchanges. The rupee value is what CoinDCX shows; dollar totals use the world price.</p>` : ''}
      ${h.kind === 'fund' ? `<p class="muted small">${[h.plan, h.option].filter(Boolean).map(esc).join(' · ')}${h.nav_date ? ` · NAV of ${fmtDate(h.nav_date)}` : ''} · ${Number(h.qty).toLocaleString('en-IN', { maximumFractionDigits: 3 })} units</p>` : ''}
      <div class="tiles">${bt('nifty', 'Moves with the Nifty 50')}${bt('sp500', 'Moves with the S&P 500')}${bt('bitcoin', 'Moves with bitcoin')}${od('h20')}</div>
      <h4>Events pressing on it now ${pr(p.score || 0)}</h4>${evs.length ? `<div class="list">${evs.slice(0, 2).map(evRow).join('')}</div>${evs.length > 2 ? moreBox(`<div class="list">${evs.slice(2).map(evRow).join('')}</div>`) : ''}` : '<p class="empty">No current event reaches its measured exposures.</p>'}
      <details class="more-card"><summary><h4>More: other links, exposures and its biggest surprise days</h4></summary>
        <div class="tiles">${bt('nasdaq', 'Moves with Nasdaq')}${bt('semis', 'Moves with chip stocks')}${od('h5')}</div>
        <h4>Measured exposures beyond the market</h4>${(h.exposures || []).length ? `<div class="tbl"><table><tbody>${h.exposures.map(x => `<tr><td>${esc(x.label)}${x.hidden ? ' <span class="tag hid">hidden</span>' : ''}</td><td class="num ${x.rho >= 0 ? 'up' : 'down'}">${sgn(x.rho)}</td><td><span class="tag ${x.cls === 'robust' ? 'good' : ''}">${esc(x.cls)}</span></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Nothing beyond the market passed the tests.</p>'}
        <h4>Its biggest surprise days, last 3 years</h4><div class="list">${(h.moves || []).map(moveHtml).join('') || '<p class="empty">No large surprises.</p>'}</div>
      </details></div>`;
    $('#holdClose').addEventListener('click', () => { OWN.open = null; box.innerHTML = ''; });
    if (!quiet) { award('holding', { holding: h.sym }); box.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' }); }
  }

  // ======================= portfolio (pasted tickers) =======================
  function parseHoldings(text) {
    const out = [], seen = new Set();
    String(text || '').split(/[,\n;]+/).forEach(part => { const m = part.trim().match(/^([A-Za-z0-9.^&\-]+)\s*[:=x]?\s*([\d.]+)?\s*%?$/); if (!m) return; const t = m[1].toUpperCase(); if (seen.has(t) || t.length > 20) return; seen.add(t); out.push({ t, w: m[2] ? Math.max(Number(m[2]), 0) : null }); });
    return out.slice(0, 60);
  }
  function resolveTicker(t) {
    const ix = STK.index ? STK.index.stocks : {};
    for (const c of [t, t.replace(/\.(?=[A-Z]$)/, '-'), `${t}.NS`, t.replace(/\.BO$/, '.NS')]) if (ix[c]) return { kind: 'stock', sym: c };
    const items = (LIVE.signals && LIVE.signals.items) || {};
    for (const [node, s] of Object.entries(items)) if (String(s.symbol).toUpperCase() === t) return { kind: 'node', node, sym: t };
    return { kind: 'none', sym: t };
  }
  function eventScore(profile) {
    const ev = (SCR.data && SCR.data.events_fp) || []; const exp = {}; (profile.exposures || []).forEach(x => { exp[x.f] = x; });
    let total = 0; const byEv = [];
    ev.forEach(e => { let c = 0; for (const [f, v] of Object.entries(e.fp || {})) { const x = exp[f]; if (x) c += v * x.rho * (x.cls === 'robust' ? 1 : 0.6); } if (Math.abs(c) > 0.002) { byEv.push({ e, c }); total += c; } });
    byEv.sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
    return { total, events: byEv };
  }
  async function analysePortfolio() {
    const out = $('#pfOut');
    if (!PF.holdings.length) { out.innerHTML = ''; return; }
    if (!STK.index || !SCR.data) { out.innerHTML = '<p class="empty">Waiting for the stock profiles and screener data to load.</p>'; return; }
    out.innerHTML = '<p class="muted">Analysing&hellip;</p>';
    const rows = [];
    for (const h of PF.holdings) { const r = resolveTicker(h.t); let p = null; try { p = r.kind === 'stock' ? await getProfile(r.sym) : null; } catch (e) { p = null; } rows.push({ ...h, ...r, p, score: p ? eventScore(p) : null }); }
    const wsum = rows.reduce((s, r) => s + (r.w == null ? 1 : r.w), 0) || 1; rows.forEach(r => { r.wt = (r.w == null ? 1 : r.w) / wsum; });
    const covered = rows.filter(r => r.p); const total = covered.reduce((s, r) => s + r.wt * r.score.total, 0);
    out.innerHTML = `<div class="tiles"><div class="tile"><span class="k">Covered</span><span class="v">${covered.length} / ${rows.length}</span></div><div class="tile"><span class="k">Net news pressure</span><span class="v">${pr(total)}</span></div></div>
      <div class="tbl"><table><thead><tr><th>Ticker</th><th>Company</th><th>Weight</th><th>Pressure</th><th>Main exposures</th><th>Events behind it</th></tr></thead><tbody>${rows.sort((a, b) => (a.score ? a.score.total : 9) - (b.score ? b.score.total : 9)).map(r => {
        if (r.kind === 'node') { const s = LIVE.signals.items[r.node]; const h20 = s && s.h20; return `<tr><td><b class="num">${esc(r.t)}</b></td><td>${esc(lbl(r.node))} <span class="muted small">(on the map)</span></td><td class="num">${pct(r.wt)}</td><td>–</td><td class="small" colspan="2">${h20 ? `${pct(h20.prob_up)} chance higher in 20 days, ${h20.has_skill ? 'beat naive' : 'no proven skill'}` : ''} <button class="linkbtn" type="button" data-go="${esc(r.node)}">Open on the map</button></td></tr>`; }
        if (!r.p) return `<tr><td><b class="num">${esc(r.t)}</b></td><td class="muted" colspan="5">Not covered yet (not in the universe, or under 3 years of history).</td></tr>`;
        return `<tr class="rowlink"><td><button class="symbtn" type="button" data-research="${esc(r.sym)}" data-rkind="stock">${esc(r.sym)}</button></td><td>${esc(r.p.name)}<br><span class="muted small">${esc(r.p.sector)}</span></td><td class="num">${pct(r.wt)}</td><td>${pr(r.score.total)}</td><td class="small">${(r.p.exposures || []).slice(0, 3).map(x => `${esc(x.label)} ${sgn(x.rho)}`).join('; ') || '<span class="muted">market and sector only</span>'}</td><td class="small">${r.score.events.slice(0, 2).map(({ e, c }) => { const u = safeUrl(e.url); return `${pr(c)} ${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(String(e.title).slice(0, 90))}</a>` : esc(String(e.title).slice(0, 90))}`; }).join('<br>') || '<span class="muted">no current event reaches it</span>'}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }
  async function savePortfolio() {
    PF.holdings = parseHoldings($('#pfInput').value);
    const doc = { holdings: PF.holdings, text: $('#pfInput').value.slice(0, 4000) };
    if (PF.ref) { try { await PF.ref.set(doc); $('#pfStatus').textContent = 'Saved privately'; } catch (e) { $('#pfStatus').textContent = 'Kept on this device only'; try { localStorage.setItem('ripple-portfolio', JSON.stringify(doc)); } catch (_) {} } }
    else { try { localStorage.setItem('ripple-portfolio', JSON.stringify(doc)); $('#pfStatus').textContent = 'Saved on this device only'; } catch (_) { $('#pfStatus').textContent = 'Not saved'; } }
    if (PF.holdings.length) award('pfscan');
    analysePortfolio(); renderHomePf();
  }
  $('#pfSave').addEventListener('click', savePortfolio);
  $('#pfClear').addEventListener('click', () => { $('#pfInput').value = ''; savePortfolio(); });

  // ======================= focus =======================
  const FOC = { data: null, tab: 'us', all: {} };
  const FTABS = { us: 'US stocks', india: 'India stocks', commodities: 'Commodities & funds', crypto: 'Crypto' };
  const heldSet = () => { const o = OWN.data; return new Set(o ? o.holdings.flatMap(h => [h.sym, short(h.sym)]) : []); };
  const fFactor = f => (FOC.data && FOC.data.factors && FOC.data.factors[f]) || fLabel(f);
  $('#fSeg').addEventListener('click', ev => { const b = ev.target.closest('button'); if (!b) return; FOC.tab = b.dataset.v; renderFocus(); });
  function fChips(r) {
    const c = [];
    if (r.kind === 'stock') c.push('<span class="tag">Model: not run on single stocks</span>');
    else if (r.model) c.push(r.model.has_skill ? `<span class="tag good">Model edge: ${pct(r.model.prob_up)} chance higher in 20 days</span>` : `<span class="tag">Model: no tested edge (${pct(r.model.prob_up)} up in 20 days)</span>`);
    const a = r.analysts;
    if (a) { const n = a.buy + a.hold + a.sell; const ch = a.balance_prev != null && Math.abs(a.balance - a.balance_prev) >= 0.05 ? (a.balance > a.balance_prev ? ' · more buys than last check' : ' · fewer buys than last check') : ''; c.push(`<span class="tag">${Math.round(a.buy / n * 100)}% of ${n} analysts rate it buy${a.target_gap != null ? ` · average target ${sp1(a.target_gap * 100)}` : ''}${ch}</span>`); }
    else if (r.kind === 'stock' && r.market === 'US') c.push('<span class="tag">No analyst coverage on Robinhood</span>');
    const t = r.trend;
    if (t && t.ret_1m != null) c.push(`<span class="tag">1 month ${sp1(t.ret_1m)} · ${t.vs_200d >= 0 ? 'above' : 'below'} its 200-day average</span>`);
    const e = r.earnings;
    if (e) c.push(`<span class="tag notable">Reports ${fmtDate(e.date)}${e.timing === 'pm' ? ' after the close' : e.timing === 'am' ? ' before the open' : ''}${e.verified === false ? ' (tentative)' : ''}</span>`);
    return c.join('');
  }
  function fLineup(lu) {
    const keys = [['model', 'Model'], ['analysts', 'Analysts'], ['trend', 'Trend']];
    const known = keys.filter(([k]) => lu[k] != null), yes = known.filter(([k]) => lu[k]).length;
    return `<div class="lineup">${keys.map(([k, n]) => `<i class="${lu[k] == null ? 'na' : lu[k] ? 'yes' : 'no'}" title="${n}: ${lu[k] == null ? 'no data' : lu[k] ? 'points the same way as the news' : 'points the other way'}"></i>`).join('')}<span>${known.length ? `${yes} of ${known.length} other ${known.length === 1 ? 'signal lines' : 'signals line'} up with the news` : 'no other evidence yet'}</span></div>`;
  }
  function fItem(r, H) {
    const isHeld = H.has(r.sym) || (r.proxy && H.has(r.proxy));
    const node = r.kind === 'crypto' ? (r.sym === 'BTC' ? 'bitcoin' : r.sym === 'ETH' ? 'ether' : null) : r.kind === 'stock' ? null : r.sym;
    const title = r.kind === 'stock' || r.kind === 'crypto' ? r.sym : r.name;
    const sub = r.kind === 'stock' ? r.name : r.kind === 'crypto' ? r.name : r.etf ? `${r.kind === 'fund' ? 'Fund' : 'Commodity'} · trades as ${r.etf}` : r.kind === 'fund' ? 'Fund' : 'Commodity · no US fund';
    const e = (r.events || [])[0]; const u = e && safeUrl(e.url);
    const why = e ? `<span class="fwhy">Pushed by ${u ? `<a href="${esc(u)}" target="_blank" rel="noopener" data-ev="">${esc(e.title)}</a>` : esc(e.title)}${r.kind === 'stock' && r.factors && r.factors.length ? ` through ${r.factors.slice(0, 2).map(f => `${esc(fFactor(f.f))} (corr ${sgn(f.rho)})`).join(' and ')}` : ''}${r.kind === 'crypto' && r.corr_btc != null && r.sym !== 'BTC' ? `; moves with bitcoin (${sgn(r.corr_btc)})` : ''}</span>` : '';
    const callKey = node && LIVE.prices && LIVE.prices.series && LIVE.prices.series[node] ? 'n:' + node : (isHeld && r.kind === 'crypto' && r.proxy ? 'h:' + r.proxy : null);
    const open = `<button class="btn quiet" type="button" data-research="${esc(r.sym)}" data-rkind="${esc(r.kind)}" data-focus="1">Research</button>${node && r.kind !== 'crypto' ? `<button class="linkbtn" type="button" data-go="${esc(node)}">Open on the graph</button>` : ''}`;
    const body = `${why}<div class="evid">${fChips(r)}</div><div class="factions">${open}${callKey ? `<button class="linkbtn" type="button" data-call="${esc(callKey)}">Make a 5-day call</button>` : ''}</div>`;
    return `<div class="fitem rowlink"><div class="ftop"><span class="fname" style="min-width:0"><b class="num">${esc(title)}</b><small class="clamp1">${esc(sub)}</small></span><span class="row" style="gap:8px;flex-wrap:nowrap">${isHeld ? '<span class="tag hid">you hold</span>' : ''}<span class="fscore ${r.dir > 0 ? 'up' : 'down'}">${r.dir > 0 ? '+' : ''}${r.score}</span></span></div>
      <span class="bar"><i style="width:${Math.min(100, Math.abs(r.score))}%"></i></span>
      ${e ? `<span class="fwhy clamp1" title="${esc(e.title)}">${esc(e.title)}</span>` : ''}
      <div class="row" style="justify-content:space-between;gap:8px">${fLineup(r.lines_up || {})}<button class="linkbtn" type="button" data-research="${esc(r.sym)}" data-rkind="${esc(r.kind)}" data-focus="1">Research</button></div>${moreBox(body, 'focus')}</div>`;
  }
  function renderFocus() {
    const d = FOC.data, own = !!OWN.data;
    $('#fPosBtn').hidden = !own;
    if (FOC.tab === 'positions' && !own) FOC.tab = 'us';
    $$('#fSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === FOC.tab ? 'true' : 'false'));
    if (!d) return;
    const dt = new Date(d.date + 'T12:00:00Z');
    $('#fTitle').textContent = `Focus for ${dt.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}`;
    $('#fMeta').innerHTML = `<span class="tag">updated ${esc(ago(d.updated))}</span>`;
    const H = heldSet();
    if (FOC.tab === 'positions') { $('#fBody').innerHTML = positionsHtml(); }
    else {
      const g = d[FOC.tab] || { up: [], down: [] };
      const key = side => FOC.tab + ':' + side;
      const col = (side, label, items) => { const all = FOC.all[key(side)], lim = all ? items.length : 5; return `<div class="fcol ${side === 'up' ? 'u' : 'd'}"><h4 class="${side}">${side === 'up' ? '▲' : '▼'} ${label} <span class="tag">${items.length}</span></h4>${items.slice(0, lim).map(r => fItem(r, H)).join('') || '<p class="empty">Nothing on this side today.</p>'}${items.length > 5 ? `<button class="more-btn" type="button" data-fall="${key(side)}">${all ? 'Show top 5' : `Show all ${items.length}`}</button>` : ''}</div>`; };
      $('#fBody').innerHTML = `<div class="fcols">${col('up', 'Tailwinds', g.up)}${col('down', 'Headwinds', g.down)}</div>`;
      $$('#fBody [data-fall]').forEach(b => b.addEventListener('click', () => { FOC.all[b.dataset.fall] = !FOC.all[b.dataset.fall]; renderFocus(); }));
    }
    const w = d.watchlist;
    if (w) $('#fWatch').innerHTML = `<div class="card-h"><h3>Robinhood watchlist</h3>${w.created ? `<span class="tag good">created ${esc(ago(w.created))}</span>` : '<span class="tag">not created yet</span>'}</div><p class="small"><b>${esc(w.name)}</b> · ${w.count} names from today&rsquo;s list, both directions.</p>${moreBox(`<div class="wl">${w.symbols.map(x => `<span class="nchip num">${esc(x)}</span>`).join('')}</div><p class="muted small">${w.created ? 'Open the Robinhood app to see it. A new dated list is added each morning.' : 'India stocks and futures cannot be added to Robinhood.'}</p>`)}`;
    const t = d.track || {}; const d1 = t.d1 || {}, d5 = t.d5 || {};
    $('#fTrack').innerHTML = `<div class="card-h"><h3>Has following the news worked?</h3><span class="tag">${t.lists || 0} earlier ${t.lists === 1 ? 'list' : 'lists'}</span></div>${d1.items ? `<div class="tiles"><div class="tile"><span class="k">Tailwinds rose</span><span class="v">${pct(d1.tailwind_rose)}</span><span class="s">next day · ${d1.tailwinds} names</span></div><div class="tile"><span class="k">Headwinds fell</span><span class="v">${pct(d1.headwind_fell)}</span><span class="s">next day · ${d1.headwinds} names</span></div><div class="tile"><span class="k">Bar to beat</span><span class="v">${pct(d1.base_rose)}</span><span class="s">share of all names that rose</span></div></div>${moreBox(`<p class="muted small">After 5 trading days: tailwinds rose ${d5.tailwind_rose != null ? pct(d5.tailwind_rose) : '(pending)'}, headwinds fell ${d5.headwind_fell != null ? pct(d5.headwind_fell) : '(pending)'}. If tailwinds rise no more often than the bar to beat, the news was already in the price. A few weeks of lists are needed before these numbers mean much.</p>`)}` : '<p class="muted small">Each day&rsquo;s list is saved. From the next trading day this card checks how the names actually moved.</p>'}`;
  }
  function renderHomeFocus() {
    const d = FOC.data; if (!d) return;
    const all = ['us', 'commodities', 'crypto'].flatMap(k => ['up', 'down'].flatMap(s => (d[k] || {})[s] || []));
    const top = side => all.filter(r => (side > 0 ? r.dir > 0 : r.dir < 0)).sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 3);
    const H = heldSet();
    const row = r => `<div class="mini-mover rowlink"><button class="symbtn" type="button" data-research="${esc(r.sym)}" data-rkind="${esc(r.kind)}">${esc(r.kind === 'commodity' || r.kind === 'fund' ? r.name : r.sym)}</button><span class="muted small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.kind === 'stock' ? r.name : r.kind)}${H.has(r.sym) || (r.proxy && H.has(r.proxy)) ? ' · you hold' : ''}</span><span class="num ${r.dir > 0 ? 'up' : 'down'}">${r.dir > 0 ? '+' : ''}${r.score}</span></div>`;
    $('#homeMovers').innerHTML = `<p class="eyebrow">Tailwinds</p>${top(1).map(row).join('')}<p class="eyebrow" style="margin-top:6px">Headwinds</p>${top(-1).map(row).join('')}`;
  }
  const posList = () => OWN.data ? byValue(OWN.data.holdings) : [];
  const posTotal = hs => hs.reduce((s, h) => s + usdOf(h), 0) || 1;
  function positionsHtml() {
    const o = OWN.data; if (!o) return '<p class="empty">Your holdings appear here for you only.</p>';
    const hs = posList(), total = posTotal(hs);
    return `<div class="grid g2">${hs.map((h, i) => {
      const t = h.trend || {}, P = pxOf(h), A = h.avg_cost, V = h.value != null ? h.value : P * h.qty, c = v => cash(v, h.ccy), known = A > 0;
      const gain = known ? (P - A) * h.qty : 0, be = known ? A / P - 1 : 0, pz = (h.pressure || {}).score || 0, o20 = (h.odds || {}).h20, a = h.analysts;
      const rupee = h.ccy === 'INR', step = rupee ? 1000 : 10, start = rupee ? 5000 : 100;
      const fact = (k, v, s) => `<div class="fact"><span class="k">${k}</span><span class="v">${v}</span>${s ? `<span class="muted small">${s}</span>` : ''}</div>`;
      return `<div class="card pos" data-pos="${i}"><div class="card-h"><h3><span class="${h.kind === 'fund' ? 'fundname' : 'num'}">${esc(hlabel(h))}</span> <span class="tag">${esc(h.kind)}</span>${h.broker && h.broker !== 'robinhood' ? ` <span class="tag">${esc(BRK[h.broker])}</span>` : ''}</h3><span class="row" style="gap:8px"><span class="muted small">${c(V)} · ${pct(usdOf(h) / total)}</span>${h.kind === 'fund' ? '' : `<button class="linkbtn" type="button" data-research="${esc(short(h.sym))}" data-rkind="${esc(h.kind)}">Research</button>`}</span></div>
        <div class="facts">${known ? fact('Gain or loss', `<span class="${gain >= 0 ? 'up' : 'down'}">${sp1((P / A - 1) * 100)}</span>`, `${gain >= 0 ? '+' : '−'}${c(Math.abs(gain))}`) + fact('To break even', be > 0 ? sp1(be * 100) : 'in profit', be > 0 ? 'rise needed' : '') : fact('Gain or loss', '–', 'average cost unknown')}${fact('News now', pr(pz), 'last 14 days')}</div>
        <details class="more" data-award="holding" data-meta="${esc(h.sym)}"><summary><span class="m1">${known ? 'Details and what-if calculator' : 'Details'}</span><span class="m2">Less</span></summary><div class="more-body">
          ${spark(h.c, 320, 46)}
          ${h.cost_note ? `<p class="muted small">${esc(h.cost_note)}</p>` : ''}
          <div class="facts">${fact('Price vs your average', c(P), known ? `average ${c(A)}` : 'average unknown')}${fact('From 1-year high', sp1(t.drawdown_1y), `vs 200-day ${sp1(t.vs_200d)}`)}${fact('Model, 20 days', o20 ? pct(o20.prob_up) : '–', o20 ? (o20.has_skill ? 'beat naive in testing' : 'no tested edge') : 'too little history')}${a ? fact('Analysts', `${Math.round(a.buy / (a.buy + a.hold + a.sell) * 100)}% buy`, a.target_gap != null ? `average target ${sp1(a.target_gap * 100)}` : '') : ''}${h.earnings ? fact('Next report', fmtDate(h.earnings.date), h.earnings.timing === 'pm' ? 'after the close' : h.earnings.timing === 'am' ? 'before the open' : '') : ''}</div>
          ${known ? `<div class="calc"><span class="eyebrow">What-if calculator</span><div class="row"><label for="ca-${i}">Add ${rupee ? '&#8377;' : '$'}<input id="ca-${i}" type="number" min="0" step="${step}" value="${start}" data-calc="add"></label><label for="cs-${i}">or sell <input id="cs-${i}" type="range" min="0" max="100" step="5" value="0" data-calc="sell"> <span class="num" id="csv-${i}">0%</span></label></div><div class="out" id="co-${i}">${calcText(h, total, start, 0)}</div></div>` : ''}
        </div></details></div>`;
    }).join('')}</div><p class="note">The calculator only does the arithmetic, before fees and taxes. Adding lowers your average cost and the rise needed to break even, but it also puts more money on the same holding, so a further fall costs more. Neither choice changes where the price goes next, and I can&rsquo;t tell you which to make: I&rsquo;m not a licensed advisor.</p>`;
  }
  function calcText(h, total, add, sellPct) {
    // amounts in the holding's own currency; total is the whole portfolio in dollars
    const P = pxOf(h), A = h.avg_cost, q = h.qty, V = P * q, c = v => cash(v, h.ccy), out = [];
    const rate = h.ccy === 'INR' && h.value_usd ? h.value / h.value_usd : 1, T = total * rate;
    if (add > 0) {
      const q2 = q + add / P, A2 = (q * A + add) / q2, V2 = q2 * P, w2 = V2 / (T + add);
      out.push(`Adding <b>${c(add)}</b> at ${c(P)}: your average becomes <b>${c(A2)}</b> (now ${c(A)}). ${A2 > P ? `It would need to rise <b>${sp1((A2 / P - 1) * 100)}</b> to break even (now ${sp1((A / P - 1) * 100)}).` : `You would stay <b>${sp1((P / A2 - 1) * 100)}</b> above your average.`} It would be ${pct(w2)} of your portfolio (now ${pct(V / T)}), and another 10% drop would cost <b>${c(V2 * 0.1)}</b> instead of ${c(V * 0.1)}.`);
    }
    if (sellPct > 0) {
      const s = sellPct / 100, real = s * q * (P - A), V2 = (1 - s) * V, w2 = V2 / Math.max(T - s * V, 1e-9);
      out.push(`Selling <b>${sellPct}%</b> (${c(s * V)}): a realized ${real >= 0 ? 'gain' : 'loss'} of <b>${c(Math.abs(real))}</b>; your average cost stays ${c(A)}, and the rest would be ${pct(w2)} of your portfolio (now ${pct(V / T)}).`);
    }
    return out.join('<br>') || 'Enter an amount to add, or slide to a share to sell, to see what changes.';
  }
  $('#fBody').addEventListener('input', ev => {
    const inp = ev.target.closest('[data-calc]'); if (!inp) return;
    const card = inp.closest('[data-pos]'); const i = card.dataset.pos;
    const hs = posList(), total = posTotal(hs);
    const add = Math.max(0, Number($('#ca-' + i).value) || 0), sell = Number($('#cs-' + i).value) || 0;
    $('#csv-' + i).textContent = sell + '%';
    $('#co-' + i).innerHTML = calcText(hs[i], total, add, sell);
  });

  // ======================= tooltips: beside the point, never on it =======================
  // Tries each side in `order` (r, l, t, b), keeps a clear gap from the point, clamps inside the box,
  // and draws a dashed leader from the point to the tooltip so it is clear which point it describes.
  function placeTip(tip, lead, box, px, py, pr, order, gap) {
    const W = box.clientWidth, H = box.clientHeight, tw = tip.offsetWidth, th = tip.offsetHeight, G = gap || 30, M = 8;
    const at = { r: [px + pr + G, py - th / 2], l: [px - pr - G - tw, py - th / 2], t: [px - tw / 2, py - pr - G - th], b: [px - tw / 2, py + pr + G] };
    let best = null;
    (order || 'rltb').split('').forEach((k, rank) => {
      const [x0, y0] = at[k];
      const x = Math.max(M, Math.min(x0, W - tw - M)), y = Math.max(M, Math.min(y0, H - th - M));
      const nx = Math.max(x, Math.min(px, x + tw)), ny = Math.max(y, Math.min(py, y + th));
      const gap = Math.hypot(nx - px, ny - py) - pr;
      const score = (gap >= G - 4 ? 1000 : gap * 10) - (Math.abs(x - x0) + Math.abs(y - y0)) - rank;
      if (!best || score > best.score) best = { x, y, nx, ny, score };
    });
    tip.style.left = Math.round(best.x) + 'px'; tip.style.top = Math.round(best.y) + 'px';
    if (!lead) return;
    const dx = best.nx - px, dy = best.ny - py, dist = Math.hypot(dx, dy);
    if (dist - pr < 8) { lead.hidden = true; return; }
    const ux = dx / dist, uy = dy / dist;
    lead.hidden = false;
    lead.style.left = (px + ux * (pr + 2)).toFixed(1) + 'px'; lead.style.top = (py + uy * (pr + 2)).toFixed(1) + 'px';
    lead.style.width = Math.max(0, dist - pr - 2).toFixed(1) + 'px'; lead.style.transform = `rotate(${Math.atan2(uy, ux)}rad)`;
  }
  const tipHtml = (meta, title, lines) => `<span class="cm">${meta}</span><span class="ct">${title}</span>${(lines || []).filter(Boolean).map(l => `<span class="cd">${l}</span>`).join('')}`;

  // ======================= research =======================
  const RES = { key: null, kind: null, doc: null, lite: false, unsub: null, tab: 'summary', srcType: 'all', tips: [], index: { pub: [], own: [] }, notes: null, notesRef: null, req: null, reqRef: null };
  const CODES = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'AVAX', 'DOGE', 'LTC', 'LINK', 'BCH', 'XLM', 'DOT', 'SHIB', 'UNI'];
  const FACTOR_NODE = { oil: 'brent', diesel: 'jet_fuel', gas_us: 'hh', gas_eu: 'ttf', uranium: 'uranium', gold: 'gold', silver: 'silver', copper: 'copper', aluminium: 'aluminium', steel: 'steel', lithium: 'lithium', wheat: 'wheat', rice: 'rice', soyoil: 'palm_oil', soybeans: 'soybeans', cocoa: 'cocoa', coffee: 'coffee', rates: 'us_yields', dollar: 'usd', rupee: 'inr', yen: 'jpy', freight: 'freight', bitcoin: 'bitcoin', semis: 'ai_chips', defense: 'defense', gpr: 'gulf_war' };
  const guessKind = key => BY[key] ? (BY[key].layer === 4 ? 'fund' : 'commodity') : CODES.includes(key) ? 'crypto' : 'stock';
  const KIND_WORD = { stock: 'Stock', crypto: 'Crypto', commodity: 'Commodity', fund: 'Fund' };
  function openResearch(key, kind) {
    if (!key) return;
    if (RES.key !== key) { RES.tab = 'summary'; RES.srcType = 'all'; RES.srcAll = false; }
    RES.key = key; RES.kind = kind || guessKind(key); RES.doc = null; RES.lite = false;
    if (VIEW !== 'research') RES.from = VIEW;
    try { localStorage.setItem('ripple-research', key); } catch (_) {}
    try { award('research'); } catch (_) {}
    go('research');
    window.scrollTo({ top: 0, behavior: 'auto' });
    loadDossier().catch(err => { $('#rBody').innerHTML = `<div class="card flat"><p class="empty">This dossier could not load (${esc(err && err.message || 'unknown error')}). Try again, or open another one.</p></div>`; });
  }
  function feedFor(node, n) {
    const W = { minor: 0.3, notable: 0.6, major: 1 };
    return ((LIVE.feed && LIVE.feed.events) || []).filter(e => (e.nodes || []).some(x => x.id === node)).slice(0, n)
      .map(e => { const x = e.nodes.find(y => y.id === node); return { id: e.id, title: e.title, url: e.url, ts: e.ts, scale: e.scale, summary: e.summary, source: e.source, c: (x.dir < 0 ? -1 : 1) * (W[e.scale] || 0.3) }; });
  }
  async function liteDossier(key, kind) {
    const pressure = (LIVE.signals && LIVE.signals.pressure) || {};
    if (BY[key]) {
      const n = BY[key];
      const ins = (IN[key] || []).slice().sort((a, b) => b.w - a.w).slice(0, 6).map(e => ({ id: e.s, label: lbl(e.s), layer: BY[e.s].layer, sign: e.sign, w: e.w, why: e.why, role: 'moves it', node: e.s, push: pressure[e.s] || 0, events: feedFor(e.s, 2) }));
      const outs = (OUT[key] || []).slice().sort((a, b) => b.w - a.w).slice(0, 4).map(e => ({ id: e.t, label: lbl(e.t), layer: BY[e.t].layer, sign: e.sign, w: e.w, why: e.why, role: 'it moves', node: e.t, push: pressure[e.t] || 0, events: [] }));
      const ps = LIVE.prices && LIVE.prices.series && LIVE.prices.series[key];
      const m = LIVE.signals && LIVE.signals.items && LIVE.signals.items[key];
      return { lite: true, key, kind: n.layer === 4 ? 'fund' : 'commodity', name: n.label, desc: n.desc, inst: n.inst, proxy: ps && ps.sym, rh: false, price: ps ? { daily: ps.c, weekly: [] } : null, model: m ? { h5: m.h5, h20: m.h20 } : null, pressure: pressure[key] || 0, graph: { drivers: ins.concat(outs) }, events: feedFor(key, 15), headlines: [], web: [], episodes: INC.filter(i => i.m.some(x => x[0] === key) || (i.shock || []).includes(key)).slice(0, 6).map(i => ({ d: i.d, t: i.t, lesson: i.lesson, src: i.src, m: i.m.filter(x => x[0] === key) })) };
    }
    if (kind === 'crypto' || CODES.includes(key)) {
      return { lite: true, key, kind: 'crypto', name: key, rh: true, price: null, graph: { drivers: [{ id: 'bitcoin', label: 'Bitcoin', layer: 4, sign: 1, w: 0.7, role: 'moves it', node: 'bitcoin', push: pressure.bitcoin || 0, events: feedFor('bitcoin', 2), why: 'coins move with bitcoin' }] }, events: feedFor('bitcoin', 12), headlines: [], web: [], episodes: [] };
    }
    let p = null; try { p = await getProfile(key); } catch (_) { p = null; }
    const efp = (SCR.data && SCR.data.events_fp) || [];
    const exp = {}; ((p && p.exposures) || []).forEach(x => { exp[x.f] = x; });
    const evs = [];
    efp.forEach(e => { let c = 0, via = null, best = 0; for (const [f, v] of Object.entries(e.fp || {})) { const x = exp[f]; if (x) { const k = v * x.rho * (x.cls === 'robust' ? 1 : 0.6); c += k; if (Math.abs(k) > Math.abs(best)) { best = k; via = f; } } } if (Math.abs(c) > 0.002) evs.push({ id: e.id, title: e.title, url: e.url, ts: e.ts, c: Math.round(c * 1000) / 1000, via }); });
    evs.sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
    const drivers = ((p && p.exposures) || []).slice(0, 8).map(x => ({ id: x.f, label: x.label, rho: x.rho, cls: x.cls, hidden: x.hidden, t: x.t, node: BY[FACTOR_NODE[x.f]] ? FACTOR_NODE[x.f] : null, push: efp.reduce((s2, e) => s2 + ((e.fp || {})[x.f] || 0), 0),
      events: efp.filter(e => Math.abs((e.fp || {})[x.f] || 0) >= 0.01).sort((a, b) => Math.abs(b.fp[x.f]) - Math.abs(a.fp[x.f])).slice(0, 2).map(e => ({ id: e.id, title: e.title, url: e.url, ts: e.ts, c: Math.round(e.fp[x.f] * x.rho * 1000) / 1000 })) }));
    return { lite: true, key, kind: 'stock', name: p ? p.name : key, sector: p && p.sector, index: p && p.index, rh: !key.includes('.'), market: key.endsWith('.NS') ? 'India' : 'US', exposures: (p && p.exposures) || [], moves: (p && p.moves) || [], graph: { drivers }, events: evs.slice(0, 20), headlines: [], web: [], episodes: [], price: null, beta_mkt: p && p.beta_mkt, beta_sector: p && p.beta_sector };
  }
  async function loadDossier() {
    const key = RES.key; if (!key) return;
    if (RES.unsub) { try { RES.unsub(); } catch (_) {} RES.unsub = null; }
    liveStop(); LV.quote = null; LV.fund = null; LV.hist = null; LV.state = 'idle';
    renderResearch();
    const db = ME.db;
    if (db) {
      for (const path of [`dossier/${key}`].concat(ME.owner ? [`owner/dossier-${key}`] : [])) {
        let snap = null; try { snap = await db.doc(path).get(); } catch (_) { snap = null; }
        if (RES.key !== key) return;
        if (snap && snap.exists) {
          RES.doc = snap.data(); RES.lite = false; renderResearch(); liveLoad();
          let first = true;
          RES.unsub = db.doc(path).onSnapshot(s => { if (first) { first = false; return; } if (RES.key === key && s.exists) { RES.doc = s.data(); renderResearch(); } }, () => {});
          return;
        }
      }
    }
    const d = await liteDossier(key, RES.kind);
    if (RES.key !== key) return;
    RES.doc = d; RES.lite = true; renderResearch(); liveLoad();
  }

  // ---------- live Robinhood data (read-only tools, asked for when a dossier opens) ----------
  const LV = { mcp: undefined, key: null, quote: null, fund: null, hist: null, state: 'idle', msg: '', code: null, unsub: null, retried: false };
  const LIVE_MSG = { needs_reauth: 'Reconnect Robinhood in claude.ai Settings, Connectors, to see live prices.', server_not_connected: 'Add the Robinhood connector in claude.ai Settings, Connectors, to see live prices.', selection_required: 'Choose which Robinhood connection to use when claude.ai asks, then reopen this dossier.', blocked_by_policy: 'Your organization blocks the Robinhood connector here.', not_in_manifest: 'Live Robinhood data is not allowed for this page yet.', approval_required: 'Live Robinhood data needs your approval.', consent_required: 'Live Robinhood data needs your approval.' };
  const ASKABLE = ['not_in_manifest', 'approval_required', 'consent_required'];
  const liveSym = d => !d || !d.rh ? null : d.kind === 'crypto' ? `${d.key}-USD` : d.kind === 'stock' ? d.key : (d.etf || null);
  const rows = r => { const p = r && (r.payload !== undefined ? r.payload : r); return (p && p.data && p.data.results) || (p && p.results) || []; };
  function liveStop() { if (LV.unsub) { try { LV.unsub(); } catch (_) {} LV.unsub = null; } LV.key = null; }
  function parseQuote(r, isC) {
    const q = rows(r)[0]; if (!q) return null;
    if (isC) { const px = Number(q.mark_price) || Number(q.ask_price) || Number(q.bid_price); const prev = Number(q.open_price); return { price: px, prev, chg: prev ? px / prev - 1 : null, at: q.updated_at, ext: false }; }
    const qt = q.quote || q, t1 = Date.parse(qt.venue_last_trade_time || '') || 0, t2 = Date.parse(qt.venue_last_non_reg_trade_time || '') || 0;
    const ext = t2 > t1, px = Number(ext ? qt.last_non_reg_trade_price : qt.last_trade_price), prev = Number(qt.adjusted_previous_close || qt.previous_close);
    return { price: px, prev, chg: prev ? px / prev - 1 : null, at: (t1 || t2) ? new Date(Math.max(t1, t2)).toISOString() : null, ext, state: qt.state, traded: qt.has_traded };
  }
  async function liveLoad(isRetry) {
    const d = RES.doc, sym = liveSym(d);
    liveStop(); LV.key = sym; if (!isRetry) LV.retried = false;
    if (!sym) { LV.state = 'none'; renderLiveBlock(); return; }
    if (LV.mcp === undefined) { try { LV.mcp = window.claude && window.claude.use ? await window.claude.use('mcp') : null; } catch (_) { LV.mcp = null; } }
    if (LV.key !== sym) return;
    if (!LV.mcp) { LV.state = 'off'; LV.msg = 'Live prices are not connected yet; showing the latest close.'; renderLiveBlock(); return; }
    LV.state = 'loading'; renderLiveBlock();
    const mcp = LV.mcp, isC = d.kind === 'crypto', tool = isC ? 'get_crypto_quotes' : 'get_equity_quotes';
    try {
      const r = await mcp.callTool('Robinhood', tool, { symbols: [sym] }, { cache: { staleTime: 30000 } });
      if (LV.key !== sym) return;
      LV.quote = parseQuote(r, isC); LV.state = LV.quote ? 'live' : 'error'; LV.msg = LV.quote ? '' : 'Robinhood has no quote for this symbol.'; renderLiveBlock(); renderChart();
      LV.unsub = mcp.watchTool('Robinhood', tool, { symbols: [sym] }, ev => {
        if (LV.key !== sym) return;
        if (ev.type === 'data') { const q = parseQuote(ev.result, isC); if (q) { LV.quote = q; LV.state = 'live'; renderLiveBlock(); } }
        else if (['needs_reauth', 'server_not_connected', 'blocked_by_policy', 'approval_required', 'not_in_manifest'].includes(ev.error && ev.error.code)) { LV.quote = null; LV.state = 'error'; LV.code = ev.error.code; LV.msg = LIVE_MSG[ev.error.code]; renderLiveBlock(); }
      }, { refetchInterval: 60000 });
      if (!isC) {
        mcp.callTool('Robinhood', 'get_equity_fundamentals', { symbols: [sym] }, { cache: { staleTime: 300000 } }).then(f => { if (LV.key !== sym) return; LV.fund = rows(f)[0] || null; if (RES.tab === 'summary') renderTab(); }).catch(() => {});
        if (!(d.price && d.price.weekly && d.price.weekly.length > 5)) {
          const start = new Date(Date.now() - 372 * 864e5).toISOString().slice(0, 19) + 'Z';
          mcp.callTool('Robinhood', 'get_equity_historicals', { symbols: [sym], start_time: start, interval: 'week' }, { cache: { staleTime: 300000 } }).then(h => { if (LV.key !== sym) return; const bars = ((rows(h)[0] || {}).bars || []).filter(b => !b.interpolated); LV.hist = bars.map(b => [String(b.begins_at).slice(0, 10), Number(b.close_price)]).filter(b => isFinite(b[1])); renderChart(); }).catch(() => {});
        }
      }
    } catch (e) {
      if (LV.key !== sym) return;
      const code = e && e.code; LV.code = code;
      if (e && e.retryable && !LV.retried) { LV.retried = true; setTimeout(() => { if (LV.key === sym) liveLoad(true); }, Math.min(e.retryAfterMs || 1500 + Math.random() * 1500, 8000)); return; }
      LV.state = 'error';
      LV.msg = LIVE_MSG[code] || (['not_granted', 'capability_disabled', 'capability_removed'].includes(code) ? 'Live prices are not available in this view; showing the morning snapshot.' : code === 'tool_error' ? `Robinhood answered with an error: ${String((e && e.message) || '').slice(0, 140)}` : code === 'server_unavailable' ? 'Robinhood is not answering right now; showing the morning snapshot.' : 'Live prices are unavailable right now; showing the morning snapshot.');
      renderLiveBlock();
    }
  }
  function renderLiveBlock() {
    const box = $('#rLive'); if (!box) return;
    const d = RES.doc || {}, t = d.trend || {}, q = LV.quote;
    const snap = t.price != null ? `<span class="big">${money(t.price)}</span><span class="muted small">last close ${t.asof ? fmtDate(t.asof) : ''}</span>` : '<span class="muted">No price history stored for this one.</span>';
    let h = '';
    if (LV.state === 'live' && q) {
      const at = q.at ? new Date(q.at) : null;
      h = `<span class="big">${money(q.price)}</span>${q.chg != null ? `<span class="${q.chg >= 0 ? 'up' : 'down'} num">${sp1(q.chg * 100)} today</span>` : ''}<span class="tag good">live · Robinhood</span>${at ? `<span class="muted small">as of ${at.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${q.ext ? ' (extended hours)' : ''}</span>` : ''}${q.state && q.state !== 'active' ? `<span class="tag bad">${esc(q.state)}</span>` : ''}`;
    } else if (LV.state === 'loading') h = `${snap}<span class="muted small">Fetching the live price from Robinhood&hellip;</span>`;
    else if (LV.state === 'none') h = `${snap}<span class="tag">${d.kind === 'stock' && d.market === 'India' ? 'not on Robinhood' : d.kind === 'commodity' && !d.etf ? 'no US fund on Robinhood' : 'snapshot'}</span>`;
    else h = `${snap}<span class="muted small">${esc(LV.msg || '')}</span>${ASKABLE.includes(LV.code) ? '<button class="btn quiet" type="button" id="rAllow">Allow live Robinhood data</button>' : ''}`;
    box.innerHTML = h;
    const al = $('#rAllow'); if (al) al.addEventListener('click', () => liveLoad());
  }

  // ---------- the graph around the asset ----------
  function egoSvg(d) {
    const W = 640, H = 430, cx = W / 2, cy = H / 2;
    const drv = ((d.graph && d.graph.drivers) || []).slice(0, 10);
    const ins = drv.filter(x => x.role !== 'it moves'), outs = drv.filter(x => x.role === 'it moves');
    const pos = [];
    const arc = (list, a0, a1) => list.forEach((x, i) => pos.push({ x, a: list.length === 1 ? (a0 + a1) / 2 : a0 + (a1 - a0) * i / (list.length - 1) }));
    if (outs.length) { arc(ins, Math.PI * 0.6, Math.PI * 1.4); arc(outs, -Math.PI * 0.35, Math.PI * 0.35); }
    else ins.forEach((x, i) => pos.push({ x, a: -Math.PI / 2 + Math.PI * 2 * i / Math.max(ins.length, 1) }));
    const R1x = 185, R1y = 128, R2x = 262, R2y = 182;
    const tip = html => { RES.tips.push(html); return RES.tips.length - 1; };
    let links = '', evs = '', nodes = '';
    pos.forEach(({ x, a }) => {
      const nx = cx + Math.cos(a) * R1x, ny = cy + Math.sin(a) * R1y;
      const strength = x.rho != null ? Math.abs(x.rho) : Math.abs(x.w || 0.3);
      const pos1 = x.rho != null ? x.rho >= 0 : (x.sign || 1) > 0;
      const col = pos1 ? 'var(--up)' : 'var(--down)';
      const r = 8 + Math.min(strength, 1) * (x.rho != null ? 22 : 10);
      const layer = x.layer != null ? x.layer : (x.node && BY[x.node] ? BY[x.node].layer : null);
      const stroke = layer != null ? `var(--l${layer})` : 'var(--accent)';
      const fromD = x.role !== 'it moves';
      const [x1, y1, x2, y2] = fromD ? [nx, ny, cx, cy] : [cx, cy, nx, ny];
      links += `<line class="kl" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" style="stroke:${col};stroke-width:${(1.2 + strength * 4).toFixed(1)};opacity:.75"/>`;
      (x.events || []).slice(0, 2).forEach((e, j, arr) => {
        const ea = a + (arr.length === 1 ? 0 : (j === 0 ? -0.14 : 0.14));
        const ex = cx + Math.cos(ea) * R2x, ey = cy + Math.sin(ea) * R2y;
        const ecol = e.scale === 'major' ? 'var(--sev)' : e.scale === 'notable' ? 'var(--accent)' : 'var(--muted)';
        const u = safeUrl(e.url);
        links += `<line class="kl" x1="${ex.toFixed(1)}" y1="${ey.toFixed(1)}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" style="stroke:var(--edge);stroke-width:1.2;opacity:.7"/>`;
        const ti = tip(tipHtml(`${esc(ago(e.ts))} · ${esc(e.scale || 'event')}`, esc(e.title), [`Pushes ${esc(x.label)} ${e.c >= 0 ? 'up' : 'down'} for this asset`, u ? 'Click to open the source' : '']));
        const dot = `<g class="ev" data-tip="${ti}" tabindex="0" role="link" aria-label="${esc(e.title)}"><circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="${e.scale === 'major' ? 8 : 6}" fill="${ecol}"/></g>`;
        evs += u ? `<a href="${esc(u)}" target="_blank" rel="noopener" data-ev="">${dot}</a>` : dot;
      });
      const rel = x.rho != null ? `Correlation ${sgn(x.rho)} with what its market and sector don&rsquo;t explain (${esc(x.cls)}${x.hidden ? ', hidden' : ''})` : `${x.role === 'it moves' ? 'It pushes this' : 'Pushes it'} the ${(x.sign || 1) > 0 ? 'same' : 'opposite'} way · weight ${Number(x.w || 0).toFixed(2)}${x.verdict ? ` · measured: ${esc(x.verdict)}` : ''}`;
      const push = Math.abs(x.push || 0) >= 0.03 ? `News is pushing it ${x.push > 0 ? 'up' : 'down'} now (${x.push > 0 ? '+' : ''}${Math.round(x.push * 100)})` : '';
      const ti = tip(tipHtml(x.role === 'it moves' ? 'It moves' : 'Moves it', esc(x.label), [rel, x.why ? esc(x.why) : '', push, x.node ? 'Click to open it on the knowledge graph' : '']));
      const anchor = Math.cos(a) > 0.25 ? 'start' : Math.cos(a) < -0.25 ? 'end' : 'middle';
      const lx = nx + Math.cos(a) * (r + 8) + (anchor === 'middle' ? 0 : 0), ly = ny + Math.sin(a) * (r + 8) + (anchor === 'middle' ? (Math.sin(a) > 0 ? 12 : -6) : 4);
      const label = x.label.length > 20 ? x.label.slice(0, 19) + '…' : x.label;
      nodes += `<g class="en" data-tip="${ti}" tabindex="0" role="button" aria-label="${esc(x.label)}"${x.node ? ` data-go="${esc(x.node)}"` : ''}><circle class="c" cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="${r.toFixed(1)}" stroke="${stroke}"/>${Math.abs(x.push || 0) >= 0.03 ? `<text x="${nx.toFixed(1)}" y="${(ny + 4).toFixed(1)}" text-anchor="middle" style="fill:${x.push > 0 ? 'var(--up)' : 'var(--down)'}">${x.push > 0 ? '▲' : '▼'}</text>` : ''}<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}">${esc(label)}</text></g>`;
    });
    const f = d.focus;
    const ci = tip(tipHtml(`${esc(KIND_WORD[d.kind] || '')}${d.sector ? ' · ' + esc(d.sector) : ''}`, esc(d.name), [f ? `On today&rsquo;s focus list: ${f.dir > 0 ? 'tailwind' : 'headwind'} ${f.dir > 0 ? '+' : ''}${f.score}` : '', `${drv.length} measured ${drv.length === 1 ? 'link' : 'links'} shown; dots on the outer ring are recent events`]));
    const short = String(d.kind === 'stock' || d.kind === 'crypto' ? d.key : d.name).slice(0, 14);
    const center = `<g class="en center" data-tip="${ci}" tabindex="0" role="img" aria-label="${esc(d.name)}"><circle class="c" cx="${cx}" cy="${cy}" r="38"/><text x="${cx}" y="${cy + 5}" text-anchor="middle">${esc(short)}</text></g>`;
    return drv.length ? `<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="What moves ${esc(d.name)} and the events pushing it">${links}${evs}${nodes}${center}</svg>` : `<p class="empty" style="padding:16px">No measured links for this one yet: its moves are mostly the market and company news.</p>`;
  }

  // ---------- price chart with event markers ----------
  function chartSvg(d) {
    let s = (LV.hist && LV.hist.length > 5) ? LV.hist : (d.price && d.price.weekly && d.price.weekly.length > 5) ? d.price.weekly : (d.price && d.price.daily) || [];
    if (s.length < 3) return `<p class="empty" style="padding:16px">${LV.state === 'loading' ? 'Loading the price history&hellip;' : 'No price history for this one yet.'}</p>`;
    const W = 640, H = 230, L = 52, Rr = 16, T = 14, B = 26;
    const vals = s.map(p => p[1]); let lo = Math.min(...vals), hi = Math.max(...vals);
    const q = LV.state === 'live' && LV.quote ? LV.quote.price : null;
    if (q) { lo = Math.min(lo, q); hi = Math.max(hi, q); }
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1; lo -= pad; hi += pad;
    const X = i => L + i / (s.length - 1) * (W - L - Rr), Y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const fmt = v => Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3);
    const path = s.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join('');
    const col = vals[vals.length - 1] >= vals[0] ? 'var(--up)' : 'var(--down)';
    let g = '';
    for (let k = 0; k <= 3; k++) { const v = lo + (hi - lo) * k / 3; g += `<line x1="${L}" x2="${W - Rr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${fmt(v)}</text>`; }
    let lastM = '';
    s.forEach((p, i) => { const m = p[0].slice(0, 7); if (m !== lastM) { lastM = m; const mo = Number(p[0].slice(5, 7)); if (i > 0 && mo % 2 === 1) g += `<text x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${MON[mo - 1]}</text>`; } });
    const idxOf = day => { let lo2 = 0, hi2 = s.length - 1; if (day < s[0][0] || day > s[hi2][0]) return -1; while (lo2 < hi2) { const mid = (lo2 + hi2) >> 1; if (s[mid][0] < day) lo2 = mid + 1; else hi2 = mid; } return lo2; };
    const tip = html => { RES.tips.push(html); return RES.tips.length - 1; };
    let mk = '';
    const evs = (d.events || []).filter(e => e.ts && Math.abs(e.c || 0.05) >= 0.02).slice(0, 14);
    evs.forEach(e => { const i = idxOf(String(e.ts).slice(0, 10)); if (i < 0) return; const ti = tip(tipHtml(`${esc(fmtDate(String(e.ts).slice(0, 10)))} · event`, esc(e.title), [e.c != null ? `Pushes it ${e.c >= 0 ? 'up' : 'down'}` : '', esc(e.source || '')])); mk += `<circle class="mk" data-tip="${ti}" tabindex="0" cx="${X(i).toFixed(1)}" cy="${Y(vals[i]).toFixed(1)}" r="6" fill="${(e.c || 0) >= 0 ? 'var(--up)' : 'var(--down)'}"/>`; });
    (d.moves || []).forEach(m => { const i = idxOf(m.d); if (i < 0) return; const x = X(i), y = Y(vals[i]); const ti = tip(tipHtml(`${esc(fmtDate(m.d))} · surprise move`, `${m.ret != null ? sgn(m.ret) + '%' : ''} in a day`, [`${Math.abs(m.z)}σ beyond its market and sector`, (m.events || []).length ? esc(m.events.join('; ')) : (m.drivers || []).length ? 'Same-day shocks: ' + m.drivers.map(z => esc(fLabel(z[0]))).join(', ') : 'No factor or logged event that day: likely company news'])); mk += `<path class="mk" data-tip="${ti}" tabindex="0" d="M${x.toFixed(1)} ${(y - 7).toFixed(1)}L${(x + 7).toFixed(1)} ${y.toFixed(1)}L${x.toFixed(1)} ${(y + 7).toFixed(1)}L${(x - 7).toFixed(1)} ${y.toFixed(1)}Z" fill="var(--gold)"/>`; });
    const live = q ? `<line x1="${L}" x2="${W - Rr}" y1="${Y(q).toFixed(1)}" y2="${Y(q).toFixed(1)}" stroke="var(--accent)" stroke-dasharray="4 4" stroke-width="1.4"/><text x="${W - Rr}" y="${(Y(q) - 5).toFixed(1)}" text-anchor="end" style="fill:var(--accent)">live ${fmt(q)}</text>` : '';
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price over the last year with event markers">${g}<path d="${path}L${X(s.length - 1).toFixed(1)} ${H - B}L${X(0).toFixed(1)} ${H - B}Z" fill="${col}" opacity=".1"/><path d="${path}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>${live}${mk}<circle cx="${X(s.length - 1).toFixed(1)}" cy="${Y(vals[vals.length - 1]).toFixed(1)}" r="3.5" fill="${col}"/></svg>`;
  }
  function bindTips(wrap) {
    if (!wrap) return;
    const tip = wrap.querySelector('.crt'), lead = wrap.querySelector('.tip-lead');
    wrap.querySelectorAll('[data-tip]').forEach(el => {
      const show = () => {
        const html = RES.tips[Number(el.dataset.tip)]; if (html == null) return;
        if (tip.hidden || tip.dataset.cur !== el.dataset.tip) { tip.innerHTML = html; tip.hidden = false; tip.classList.remove('on'); void tip.offsetWidth; tip.classList.add('on'); tip.dataset.cur = el.dataset.tip; }
        wrap.querySelectorAll('.tip-on').forEach(x => x.classList.remove('tip-on')); el.classList.add('tip-on');
        const wr = wrap.getBoundingClientRect(), r = (el.querySelector('circle, path') || el).getBoundingClientRect();
        placeTip(tip, lead, wrap, r.left + r.width / 2 - wr.left, r.top + r.height / 2 - wr.top, Math.max(r.width, r.height) / 2 + 2);
      };
      const hide = () => { el.classList.remove('tip-on'); tip.hidden = true; lead.hidden = true; tip.dataset.cur = ''; };
      el.addEventListener('pointerenter', show); el.addEventListener('pointerleave', hide); el.addEventListener('focus', show); el.addEventListener('blur', hide);
    });
  }
  function renderChart() {
    const box = $('#rChart'); if (!box || !RES.doc) return;
    const keep = RES.tips.length;
    box.innerHTML = chartSvg(RES.doc) + '<div class="crt" hidden></div><div class="tip-lead" hidden></div>';
    bindTips(box);
    const src = $('#rChartSrc'); if (src) src.textContent = LV.hist && LV.hist.length > 5 ? 'weekly closes from Robinhood' : 'weekly closes';
    void keep;
  }

  // ---------- dossier tabs ----------
  const SRC_LABEL = { event: 'Event log', headline: 'Headline', filing: 'SEC filing', web: 'Web' };
  function sourceItems(d) {
    const items = [];
    (d.events || []).forEach(e => items.push({ type: 'event', ts: e.ts, title: e.title, url: e.url, source: e.source, body: e.summary, extra: e.via ? (e.via === 'mentions it' || e.via === 'logged against it' ? e.via : `through ${fLabel(e.via)}`) : '', c: e.c, scale: e.scale }));
    (d.headlines || []).forEach(h => items.push({ type: h.topic === 'sec-filings' ? 'filing' : 'headline', ts: h.ts, title: h.title, url: h.url, source: h.source || h.feed }));
    (d.web || []).forEach(w => items.push({ type: 'web', ts: w.published || w.found, title: w.title, url: w.url, source: w.source, body: w.takeaway, extra: w.found ? `found ${fmtDate(w.found)}` : '' }));
    items.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    return items;
  }
  function tabSummary(d) {
    const t = d.trend || {}, f = d.focus, a = (d.analysts || []).slice(-1)[0], fund = LV.fund || d.fundamentals;
    const fact = (k, v, s2) => `<div class="fact"><span class="k">${k}</span><span class="v">${v}</span>${s2 ? `<span class="muted small">${s2}</span>` : ''}</div>`;
    const top = [
      fact('1 month', t.ret_1m != null ? `<span class="${t.ret_1m >= 0 ? 'up' : 'down'}">${sp1(t.ret_1m)}</span>` : '–', t.ret_1y != null ? `1 year ${sp1(t.ret_1y)}` : ''),
      fact('vs 200-day average', t.vs_200d != null ? sp1(t.vs_200d) : '–', t.drawdown_1y != null ? `${sp1(t.drawdown_1y)} from 1-year high` : ''),
      f ? fact('Focus score', `<span class="${f.dir > 0 ? 'up' : 'down'}">${f.dir > 0 ? '+' : ''}${f.score}</span>`, f.dir > 0 ? 'tailwind today' : 'headwind today') : d.pressure != null ? fact('News pressure', pr(d.pressure), 'graph pressure now') : '',
      a ? fact('Analysts', `${Math.round(a.buy / ((a.buy + a.hold + a.sell) || 1) * 100)}% buy`, a.target_gap != null ? `average target ${sp1(a.target_gap * 100)}` : '') : '',
      d.earnings ? fact('Next report', fmtDate(d.earnings.date), d.earnings.timing === 'pm' ? 'after the close' : d.earnings.timing === 'am' ? 'before the open' : '') : '',
      d.model && d.model.h20 ? fact('Model, 20 days', pct(d.model.h20.prob_up), d.model.h20.has_skill ? 'beat naive in testing' : 'no tested edge') : '',
    ].filter(Boolean).join('');
    const why = f && f.events && f.events[0] ? `<p class="small"><b>Why it is on today&rsquo;s list:</b> ${safeUrl(f.events[0].url) ? `<a href="${esc(safeUrl(f.events[0].url))}" target="_blank" rel="noopener" data-ev="">${esc(f.events[0].title)}</a>` : esc(f.events[0].title)}</p>${fLineup(f.lines_up || {})}` : '';
    const fmtBig = v => { const n = Number(v); if (!isFinite(n) || !n) return '–'; return n >= 1e12 ? `$${(n / 1e12).toFixed(2)} trillion` : n >= 1e9 ? `$${(n / 1e9).toFixed(1)} billion` : `$${(n / 1e6).toFixed(0)} million`; };
    const num = (v, dgt) => v == null || v === '' || !isFinite(Number(v)) ? 'not applicable' : Number(v).toFixed(dgt);
    const fundRows = fund ? [
      ['Market value', fmtBig(fund.market_cap)], ['Price to earnings', num(fund.pe_ratio, 1)], ['Price to book', num(fund.pb_ratio, 1)],
      ['Dividend yield', fund.dividend_yield == null ? 'none' : `${Number(fund.dividend_yield).toFixed(2)}%`], ['52-week range', fund.low_52_weeks ? `${money(Number(fund.low_52_weeks))} to ${money(Number(fund.high_52_weeks))}` : '–'],
      ['Sector', [fund.sector, fund.industry].filter(Boolean).map(esc).join(' · ')], ['Chief executive', esc(fund.ceo || '–')], ['Headquarters', [fund.headquarters_city, fund.headquarters_state].filter(Boolean).map(esc).join(', ') || '–'],
      ['Employees', fund.num_employees ? Number(fund.num_employees).toLocaleString('en-US') : '–'], ['Founded', esc(fund.year_founded || '–')],
    ] : [];
    const fundBox = fund ? `<div class="tbl"><table><tbody>${fundRows.map(([k, v]) => `<tr><td class="muted small">${k}</td><td class="num">${v}</td></tr>`).join('')}</tbody></table></div>${fund.description ? `<p class="small muted">${esc(fund.description)}</p>` : ''}<p class="muted small">${LV.fund ? 'Live from Robinhood' : `Robinhood snapshot${d.fundamentals_asof ? ' from ' + fmtDate(d.fundamentals_asof) : ''}`}</p>` : '';
    const ex = (d.exposures || []).slice(0, 6);
    const exBox = ex.length ? `<div class="tbl"><table><tbody>${ex.map(x => `<tr><td>${esc(x.label)}${x.hidden ? ' <span class="tag hid">hidden</span>' : ''}</td><td class="num ${x.rho >= 0 ? 'up' : 'down'}">${sgn(x.rho)}</td><td><span class="tag ${x.cls === 'robust' ? 'good' : ''}">${esc(x.cls)}</span></td></tr>`).join('')}</tbody></table></div>` : '';
    const more = [fundBox ? `<h4>Company and valuation</h4>${fundBox}` : '', exBox ? `<h4>Measured exposures beyond its market</h4>${exBox}` : '', d.desc ? `<p class="small muted">${esc(d.desc)}</p>` : '', d.beta_mkt != null ? `<p class="small muted">Moves ${d.beta_mkt}× the market${d.beta_sector != null ? ` and ${d.beta_sector}× its sector` : ''}.</p>` : '', d.corr_btc != null ? `<p class="small muted">Weekly correlation with bitcoin over 3 years: ${sgn(d.corr_btc)}.</p>` : ''].filter(Boolean).join('');
    return `<div class="facts">${top}</div>${why}${more ? moreBox(more) : ''}`;
  }
  function tabSources(d) {
    const items = sourceItems(d);
    const counts = items.reduce((m, i) => (m[i.type] = (m[i.type] || 0) + 1, m), {});
    const types = ['all'].concat(['event', 'headline', 'web', 'filing'].filter(k => counts[k]));
    if (!types.includes(RES.srcType)) RES.srcType = 'all';
    const list = items.filter(i => RES.srcType === 'all' || i.type === RES.srcType).slice(0, RES.srcAll ? 80 : 12);
    const filters = `<div class="seg" role="group" aria-label="Source type">${types.map(k => `<button type="button" data-src="${k}" aria-pressed="${RES.srcType === k}">${k === 'all' ? `All ${items.length}` : `${SRC_LABEL[k]} ${counts[k]}`}</button>`).join('')}</div>`;
    const row = i => { const u = safeUrl(i.url); return `<div class="src-item"><div class="meta"><span class="num">${i.ts ? esc(String(i.ts).length > 10 ? ago(i.ts) : fmtDate(i.ts)) : ''}</span><span class="tag t-${i.type}">${SRC_LABEL[i.type]}</span>${i.c != null ? `<span class="${i.c >= 0 ? 'up' : 'down'} num">${i.c >= 0 ? '▲' : '▼'}</span>` : ''}${i.source ? `<span>${esc(i.source)}</span>` : ''}</div>${u ? `<a class="ttl" href="${esc(u)}" target="_blank" rel="noopener" data-ev="">${esc(i.title)}</a>` : `<span class="ttl">${esc(i.title)}</span>`}${i.body || i.extra ? moreBox(`${i.body ? `<span class="small">${esc(i.body)}</span>` : ''}${i.extra ? `<span class="muted small">${esc(i.extra)}</span>` : ''}`) : ''}</div>`; };
    const web = d.web_searched ? `<p class="muted small">Web search last run ${fmtDate(d.web_searched)}.</p>` : `<p class="muted small">No web search yet for this one: press Find more, or it runs with the morning job if this is on today&rsquo;s list or in your portfolio.</p>`;
    return items.length ? `${filters}<div>${list.map(row).join('')}</div>${items.filter(i => RES.srcType === 'all' || i.type === RES.srcType).length > 12 ? `<button class="more-btn" type="button" id="rSrcAll">${RES.srcAll ? 'Show fewer' : 'Show all'}</button>` : ''}${web}` : `<p class="empty">No sources gathered yet.</p>${web}`;
  }
  function tabHistory(d) {
    const mv = (d.moves || []).map(moveHtml).join('');
    const eps = (d.episodes || []).map(i => `<div class="src-item"><div class="meta"><span class="num">${fmtDate(i.d)}</span></div><span class="ttl">${esc(i.t)}</span>${(i.m || []).length ? `<span class="small">${i.m.map(m => `<span class="${m[1] > 0 ? 'up' : 'down'}">${arrow(m[1])} ${esc(lbl(m[0]))}</span> ${esc(m[2])}`).join('; ')}</span>` : ''}${moreBox(`<span class="small muted">${esc(i.lesson || '')}</span>${safeUrl(i.src) ? `<a class="small" href="${esc(safeUrl(i.src))}" target="_blank" rel="noopener">Source</a>` : ''}`)}</div>`).join('');
    const an = (d.analysts || []).slice(-8).reverse();
    const anBox = an.length > 1 ? `<h4>Analyst view over time</h4><div class="tbl"><table><thead><tr><th>Date</th><th>Buy</th><th>Hold</th><th>Sell</th><th>Target vs price</th></tr></thead><tbody>${an.map(r => `<tr><td class="num">${fmtDate(r.date)}</td><td class="num">${r.buy}</td><td class="num">${r.hold}</td><td class="num">${r.sell}</td><td class="num">${r.target_gap != null ? sp1(r.target_gap * 100) : '–'}</td></tr>`).join('')}</tbody></table></div>` : '';
    return `${mv ? `<h4>Biggest surprise days</h4><div class="list">${mv}</div>` : ''}${eps ? `<h4>Past episodes that touched what moves it</h4><div>${eps}</div>` : ''}${anBox}` || '<p class="empty">No history gathered yet.</p>';
  }
  function tabNotes(d) {
    const n = RES.notes && RES.notes.items && RES.notes.items[d.key];
    return `<label for="rNote" class="eyebrow">Your notes on ${esc(d.key)}</label><textarea class="note-box" id="rNote" placeholder="What you found, what to check next, what would change your mind">${esc(n ? n.text : '')}</textarea><p class="muted small" id="rNoteState">${ME.uid ? (n ? `Saved privately ${esc(ago(n.updated))}` : 'Saved privately as you type. Only you can see them.') : 'Notes are kept on this device only.'}</p>`;
  }
  function renderTab() {
    const box = $('#rTab'), d = RES.doc; if (!box || !d) return;
    $$('#rTabs button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === RES.tab ? 'true' : 'false'));
    box.innerHTML = RES.tab === 'sources' ? tabSources(d) : RES.tab === 'history' ? tabHistory(d) : RES.tab === 'notes' ? tabNotes(d) : tabSummary(d);
    box.querySelectorAll('[data-src]').forEach(b => b.addEventListener('click', () => { RES.srcType = b.dataset.src; RES.srcAll = false; renderTab(); }));
    const sa = $('#rSrcAll'); if (sa) sa.addEventListener('click', () => { RES.srcAll = !RES.srcAll; renderTab(); });
    const note = $('#rNote'); if (note) note.addEventListener('input', () => saveNote(d.key, note.value));
    if (RES.tab === 'notes') notesInit();
  }
  function requestState(d) {
    const r = RES.req && (RES.req.items || []).slice().reverse().find(x => x.key === d.key);
    if (r && r.status !== 'done') return `<span class="tag">Find more requested ${esc(ago(r.at))}</span>`;
    return `<button class="btn quiet" type="button" id="rFind">Find more</button>${r && r.status === 'done' ? `<span class="tag good">web facts added ${esc(ago(r.done || r.at))}</span>` : ''}`;
  }
  function renderResearch() {
    if (VIEW !== 'research') return;
    const d = RES.doc;
    RES.tips = [];
    if (!RES.key) {
      $('#rTitle').textContent = 'Research'; $('#rActions').innerHTML = '';
      const picks = RES.index.own.concat(RES.index.pub).slice(0, 40);
      $('#rBody').innerHTML = `<div class="card flat"><p class="small">Type a name above, or press Research on any card. Full dossiers exist for today&rsquo;s focus names${OWN.data ? ' and your holdings' : ''}; anything else opens as a quick view that Find more can fill in.</p>${picks.length ? `<div class="quick">${picks.map(i => `<button class="chip" type="button" data-research="${esc(i.key)}" data-rkind="${esc(i.kind)}">${esc(i.kind === 'stock' || i.kind === 'crypto' ? i.key : i.name)}</button>`).join('')}</div>` : ''}</div>`;
      return;
    }
    if (!d) { $('#rTitle').textContent = RES.key; $('#rBody').innerHTML = `<div class="card flat"><p class="muted">Opening the dossier for ${esc(RES.key)}&hellip;</p></div>`; return; }
    const isTicker = d.kind === 'stock' || d.kind === 'crypto';
    $('#rTitle').innerHTML = isTicker ? `${esc(d.name)} <span class="muted num" style="font-size:1rem">${esc(d.key)}</span>` : esc(d.name);
    $('#rLead').textContent = d.kind === 'stock' ? [d.sector, d.index || d.market].filter(Boolean).join(' · ') : d.kind === 'crypto' ? 'Crypto, moves mostly with bitcoin' : (d.inst || KIND_WORD[d.kind]);
    const arenaKey = d.kind !== 'stock' && BY[d.key] && LIVE.prices && LIVE.prices.series && LIVE.prices.series[d.key] ? 'n:' + d.key : d.kind === 'crypto' && (d.key === 'BTC' || d.key === 'ETH') ? 'n:' + (d.key === 'BTC' ? 'bitcoin' : 'ether') : null;
    const back = RES.from && RES.from !== 'research' ? `<button class="btn quiet" type="button" id="rBack">&larr; Back to ${esc($('#v-' + RES.from).dataset.title)}</button>` : '';
    $('#rActions').innerHTML = `${back}${requestState(d)}${BY[d.key] ? `<button class="btn quiet" type="button" data-go="${esc(d.key)}">Open on the graph</button>` : ''}${d.kind === 'stock' && STK.index && STK.index.stocks[d.key] ? `<button class="btn quiet" type="button" data-stock="${esc(d.key)}">Exposure profile</button>` : ''}${arenaKey ? `<button class="btn quiet" type="button" data-call="${esc(arenaKey)}">Make a 5-day call</button>` : ''}`;
    const fb = $('#rFind'); if (fb) fb.addEventListener('click', findMore);
    const bk = $('#rBack'); if (bk) bk.addEventListener('click', () => go(RES.from, true));
    const held = heldSet().has(d.key) || (d.proxy && heldSet().has(d.proxy));
    const nSrc = sourceItems(d).length;
    $('#rBody').innerHTML = `
      <div class="card rhead"><div class="rprice" id="rLive"></div><div class="row" style="gap:6px">${held ? '<span class="tag hid">you hold this</span>' : ''}${d.lite ? '<span class="tag">quick view</span>' : `<span class="tag">dossier updated ${esc(ago(d.updated))}</span>`}</div></div>
      ${d.lite ? '<p class="note">Quick view, built from the map&rsquo;s own data. Press <b>Find more</b> and the next job run adds web facts, headlines and the full dossier (it runs about every 2 hours).</p>' : ''}
      <div class="rgrid">
        <div class="grid" style="min-width:0">
          <div class="card"><div class="card-h"><h3>What moves it</h3><span class="eyebrow">and the events pushing it now</span></div><div class="ego-wrap ego" id="rEgo">${egoSvg(d)}<div class="crt" hidden></div><div class="tip-lead" hidden></div></div><p class="muted small">Inner ring: what moves it (green same way, red opposite; thicker is stronger). Outer dots: recent events, darkest for major. Hover for details; click a driver to open it on the graph, or an event to read the source.</p></div>
          <div class="card"><div class="card-h"><h3>Price, last year</h3><span class="muted small" id="rChartSrc"></span></div><div class="chart-wrap" id="rChart"></div><p class="muted small">Dots mark logged events (green pushes it up, red down); diamonds mark its biggest surprise days.</p></div>
        </div>
        <div class="card" style="min-width:0">
          <div class="seg" id="rTabs" role="group" aria-label="Dossier sections"><button type="button" data-v="summary" aria-pressed="true">Summary</button><button type="button" data-v="sources" aria-pressed="false">Sources ${nSrc}</button><button type="button" data-v="history" aria-pressed="false">History</button><button type="button" data-v="notes" aria-pressed="false">Notes</button></div>
          <div id="rTab" class="grid" style="gap:12px"></div>
        </div>
      </div>`;
    renderLiveBlock(); renderChart(); bindTips($('#rEgo')); renderTab();
    $('#rTabs').addEventListener('click', ev => { const b = ev.target.closest('button'); if (!b) return; RES.tab = b.dataset.v; renderTab(); });
  }
  async function findMore() {
    const d = RES.doc; if (!d) return;
    if (!ME.db || !ME.uid) { toast('Find more works when this page is open in Claude', null); return; }
    RES.reqRef = RES.reqRef || ME.db.doc(`data/users/${ME.uid}/requests`);
    const items = (RES.req && Array.isArray(RES.req.items)) ? RES.req.items.slice() : [];
    if (!items.some(r => r.key === d.key && r.status !== 'done')) items.push({ key: d.key, kind: d.kind, name: String(d.name || d.key).slice(0, 80), at: new Date().toISOString(), status: 'pending' });
    const doc = { items: items.slice(-50) };
    try { await RES.reqRef.set(doc); RES.req = doc; toast(`Requested more on ${d.key}: the next job run fills it in`, null); }
    catch (e) { toast('Could not save the request. Try again in a moment.', null); }
    renderResearch();
  }
  function notesInit() {
    if (RES.notes) return;
    if (!ME.db || !ME.uid) { try { RES.notes = JSON.parse(localStorage.getItem('ripple-notes') || 'null') || { items: {} }; } catch (_) { RES.notes = { items: {} }; } if (RES.tab === 'notes') renderTab(); return; }
    RES.notesRef = ME.db.doc(`data/users/${ME.uid}/notes`);
    RES.notesRef.get().then(s => { RES.notes = s.exists ? s.data() : { items: {} }; if (!RES.notes.items) RES.notes.items = {}; if (RES.tab === 'notes' && !(document.activeElement && document.activeElement.id === 'rNote')) renderTab(); }).catch(() => { RES.notes = { items: {} }; });
  }
  let noteTimer = null, noteSaving = false, noteDirty = false;
  function saveNote(key, text) {
    RES.notes = RES.notes || { items: {} }; RES.notes.items = RES.notes.items || {};
    RES.notes.items[key] = { text: text.slice(0, 5000), updated: new Date().toISOString() };
    const st = $('#rNoteState'); if (st) st.textContent = 'Saving…';
    clearTimeout(noteTimer); noteTimer = setTimeout(flushNotes, 900);
  }
  async function flushNotes() {
    const st = () => $('#rNoteState');
    if (!RES.notesRef) { try { localStorage.setItem('ripple-notes', JSON.stringify(RES.notes)); if (st()) st().textContent = 'Saved on this device'; } catch (_) {} return; }
    if (noteSaving) { noteDirty = true; return; }
    noteSaving = true;
    try { await RES.notesRef.set(RES.notes); if (st()) st().textContent = 'Saved privately'; } catch (_) { if (st()) st().textContent = 'Could not save; your text is still here. Keep typing to retry.'; }
    noteSaving = false;
    if (noteDirty) { noteDirty = false; flushNotes(); }
  }
  function researchIndex() {
    const opts = new Map();
    RES.index.own.concat(RES.index.pub).forEach(i => opts.set(i.key, i.kind === 'stock' || i.kind === 'crypto' ? `${i.key} · ${i.name}` : `${i.name}`));
    NODES.filter(n => n.layer >= 1).forEach(n => { if (!opts.has(n.id)) opts.set(n.id, n.label); });
    $('#rList').innerHTML = [...opts.entries()].map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
  }
  $('#rQ').addEventListener('change', e => {
    const q = e.target.value.trim(); if (!q) return;
    const up = q.toUpperCase(), all = RES.index.own.concat(RES.index.pub);
    let hit = all.find(i => i.key.toUpperCase() === up) || all.find(i => String(i.name).toLowerCase() === q.toLowerCase());
    if (!hit && BY[q]) hit = { key: q };
    if (!hit) { const n = NODES.find(x => x.label.toLowerCase().includes(q.toLowerCase())); if (n) hit = { key: n.id }; }
    if (!hit && CODES.includes(up)) hit = { key: up, kind: 'crypto' };
    if (!hit && STK.index) { const s2 = STK.index.stocks[up] ? up : (Object.entries(STK.index.stocks).find(([, v]) => v[0].toLowerCase().includes(q.toLowerCase())) || [])[0]; if (s2) hit = { key: s2, kind: 'stock' }; }
    if (hit) { e.target.value = ''; openResearch(hit.key, hit.kind); } else toast(`No asset matches "${q}"`, null);
  });

  // ======================= arena =======================
  const CALL = { asset: null, dir: 0 };
  function callAssets() {
    const out = [];
    const seen = new Set();
    if (OWN.data) OWN.data.holdings.forEach(h => { if (seen.has(h.sym)) return; seen.add(h.sym); if (h.c && h.c.length > 5) out.push({ key: 'h:' + h.sym, label: `${hlabel(h)} (your holding)`, c: h.c, kind: 'price', model: (h.odds || {}).h5, grp: 'Your holdings' }); });
    const ps = (LIVE.prices && LIVE.prices.series) || {};
    Object.entries(ps).forEach(([node, s]) => { if (BY[node]) out.push({ key: 'n:' + node, label: lbl(node), c: s.c, kind: s.kind, model: ((LIVE.signals && LIVE.signals.items[node]) || {}).h5, grp: LAYERS[BY[node].layer] }); });
    return out;
  }
  const findAsset = key => callAssets().find(a => a.key === key);
  function renderArena() {
    const as = callAssets(); const sel = $('#callAsset');
    if (!as.length) { sel.innerHTML = '<option>Loading assets&hellip;</option>'; }
    else if (sel.options.length !== as.length) {
      const groups = {}; as.forEach(a => (groups[a.grp] = groups[a.grp] || []).push(a));
      sel.innerHTML = Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(a => `<option value="${esc(a.key)}">${esc(a.label)}</option>`).join('')}</optgroup>`).join('');
      if (!CALL.asset || !findAsset(CALL.asset)) CALL.asset = as[0].key;
      sel.value = CALL.asset;
    }
    if (LIVE.prices) $('#callAsof').textContent = `prices to ${fmtDate(Object.values(LIVE.prices.series)[0].c.slice(-1)[0][0])}`;
    renderCallContext(); resolveCalls(); renderCalls();
  }
  function renderCallContext() {
    const a = findAsset(CALL.asset); if (!a) return;
    const last = a.c[a.c.length - 1], prev = a.c[Math.max(0, a.c.length - 6)];
    const ch = (last[1] / prev[1] - 1) * 100 * (a.kind === 'inverse' ? -1 : 1);
    const m = a.model;
    $('#callContext').innerHTML = `<div class="row" style="align-items:center">${spark(a.c, 200, 46)}<div class="small"><b>${esc(a.label)}</b><br>Last close ${a.kind === 'yield' ? last[1].toFixed(2) + '%' : last[1].toLocaleString('en-US', { maximumFractionDigits: 4 })} on ${fmtDate(last[0])} · ${a.kind === 'yield' ? `${sgn((last[1] - prev[1]))} pt` : sp1(ch)} over 5 days<br>${m ? `Model: <b>${pct(m.prob_up)}</b> chance higher in 5 days, ${m.has_skill ? '<span class="tag good">beat naive</span>' : '<span class="tag">no proven skill</span>'}` : '<span class="muted">No model forecast for this one.</span>'}</div></div>`;
  }
  $('#callAsset').addEventListener('change', e => { CALL.asset = e.target.value; renderCallContext(); });
  function setDir(d) { CALL.dir = d; $('#callUp').setAttribute('aria-pressed', d > 0 ? 'true' : 'false'); $('#callDown').setAttribute('aria-pressed', d < 0 ? 'true' : 'false'); $('#callGo').classList.toggle('ready', !!d); if (d) callNote(''); }
  // the button always answers: it says what is missing instead of sitting disabled
  function callNote(text, kind) { const m = $('#callMsg'); m.textContent = text || 'Pick Higher or Lower, set how sure you are, then lock it in.'; m.className = 'small ' + (kind === 'warn' ? 'callwarn' : kind === 'ok' ? 'callok' : 'muted'); }
  $('#callUp').addEventListener('click', () => setDir(1)); $('#callDown').addEventListener('click', () => setDir(-1));
  $('#callConf').addEventListener('input', e => { $('#callConfV').textContent = e.target.value + '%'; });
  $('#callGo').addEventListener('click', () => {
    const a = findAsset(CALL.asset);
    if (!a) { callNote('Prices are still loading. Try again in a moment.', 'warn'); return; }
    if (!CALL.dir) { callNote('Pick Higher or Lower first.', 'warn'); const p = $('.dirpick'); p.classList.remove('nudge'); void p.offsetWidth; p.classList.add('nudge'); $('#callUp').focus(); return; }
    const last = a.c[a.c.length - 1];
    if (PROG.calls.some(c => c.key === a.key && c.status === 'open')) { callNote(`You already have an open call on ${a.label}. It resolves 5 trading days after ${fmtDate(PROG.calls.find(c => c.key === a.key && c.status === 'open').base_date)}; pick another asset meanwhile.`, 'warn'); return; }
    const conf = Number($('#callConf').value) / 100;
    PROG.calls.unshift({ id: Date.now().toString(36), key: a.key, label: a.label, dir: CALL.dir, conf, made: today(), base_date: last[0], base: last[1], kind: a.kind, model_p: a.model ? a.model.prob_up : null, status: 'open' });
    PROG.calls = PROG.calls.slice(0, 200);
    const said = `${a.label} ${CALL.dir > 0 ? 'higher' : 'lower'} in 5 trading days, ${Math.round(conf * 100)}% sure`;
    setDir(0); award('call'); renderCalls();
    callNote(`Locked in: ${said}. It resolves by itself when the prices arrive; see it under Your calls.`, 'ok');
    toast(`Call locked in: ${said}`, null);
    const row = $('#callsTbl tbody tr'); if (row) { row.classList.add('fresh'); setTimeout(() => row.classList.remove('fresh'), 2600); }
  });
  function resolveCalls() {
    let changed = false;
    PROG.calls.forEach(c => {
      if (c.status !== 'open') return;
      const a = findAsset(c.key); if (!a) return;
      const i = a.c.findIndex(p => p[0] === c.base_date);
      if (i < 0 || i + 5 >= a.c.length) { if (i < 0 && a.c[0][0] > c.base_date && a.c.length) { c.status = 'void'; changed = true; } return; }
      const end = a.c[i + 5];
      const raw = end[1] - c.base; const upMove = (a.kind === 'inverse' ? -raw : raw) > 0;
      const pUp = c.dir > 0 ? c.conf : 1 - c.conf; const o = upMove ? 1 : 0;
      c.brier = Math.round(((pUp - o) ** 2) * 1e4) / 1e4; c.model_brier = c.model_p != null ? Math.round(((c.model_p - o) ** 2) * 1e4) / 1e4 : null;
      c.right = (c.dir > 0) === upMove; c.end_date = end[0]; c.end = end[1]; c.status = 'resolved'; changed = true;
      const pts = Math.max(5, Math.round((0.25 - c.brier) * 240));
      gainXp(pts, `${c.label}: call ${c.right ? 'right' : 'wrong'}, Brier ${c.brier.toFixed(2)}`);
    });
    if (changed) { checkBadges(); save(); renderPlayer(); }
  }
  function renderCalls() {
    const cs = PROG.calls; const rs = resolved(PROG);
    $('#callsCount').textContent = cs.length ? `${cs.filter(c => c.status === 'open').length} open · ${rs.length} resolved · ${rs.filter(c => c.right).length} right` : '';
    $('#callsTbl').innerHTML = cs.length ? `<table><thead><tr><th>Made</th><th>Asset</th><th>Call</th><th>Sure</th><th>Model</th><th>Outcome</th><th>Your Brier</th><th>Model Brier</th></tr></thead><tbody>${cs.slice(0, 40).map(c => `<tr><td class="num small">${fmtDate(c.made)}</td><td>${esc(c.label)}</td><td class="${c.dir > 0 ? 'up' : 'down'}"><b>${c.dir > 0 ? '▲ higher' : '▼ lower'}</b></td><td class="num">${pct(c.conf)}</td><td class="num muted">${c.model_p != null ? pct(c.model_p) + ' up' : '–'}</td><td>${c.status === 'open' ? '<span class="tag">open</span>' : c.status === 'void' ? '<span class="tag">no price data</span>' : `<span class="tag ${c.right ? 'good' : 'bad'}">${c.right ? 'right' : 'wrong'}</span> <span class="muted small">${fmtDate(c.end_date)}</span>`}</td><td class="num">${c.brier != null ? c.brier.toFixed(2) : '–'}</td><td class="num muted">${c.model_brier != null ? c.model_brier.toFixed(2) : '–'}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No calls yet. Make your first one above.</p>';
    const withM = rs.filter(c => c.model_brier != null);
    if (rs.length) {
      const you = avg(rs.map(c => c.brier)), mod = withM.length ? avg(withM.map(c => c.model_brier)) : null;
      $('#vsBox').innerHTML = `<div class="vs"><div class="side"><span class="eyebrow">You</span><b>${you.toFixed(3)}</b><span class="small muted">${rs.filter(c => c.right).length} of ${rs.length} right</span></div><span class="x">vs</span><div class="side"><span class="eyebrow">Model</span><b>${mod != null ? mod.toFixed(3) : '–'}</b><span class="small muted">same calls</span></div></div><p class="small muted">Lower is better. 0.250 is what always saying 50% scores. ${mod != null ? (you < mod ? 'You are ahead of the model so far.' : 'The model is ahead so far.') : ''} Ten or more calls are needed before the gap means much.</p>`;
    }
  }

  // ======================= data =======================
  (async function initData() {
    loadLocal(); renderPlayer();
    let db = null; try { db = window.claude && window.claude.use ? await window.claude.use('db') : null; } catch (e) { db = null; }
    let user = null; try { user = window.claude && window.claude.use ? await window.claude.use('user') : null; } catch (e) { user = null; }
    ME.db = db; ME.user = user;
    try { ME.owner = user ? await user.isOwner() : false; } catch (_) { ME.owner = false; }
    try { ME.uid = user ? await user.id() : null; } catch (_) { ME.uid = null; }
    if (!db) {
      $('#pfPaste').open = true;
      $('#liveText').textContent = 'Open in Claude for live data'; $('#railStatus').textContent = 'Live data works when this page is opened in Claude.';
      try { const d = JSON.parse(localStorage.getItem('ripple-portfolio') || 'null'); if (d && d.text) { $('#pfInput').value = d.text; PF.holdings = parseHoldings(d.text); } } catch (_) {}
      return;
    }
    STK.db = db;
    const sub = (path, key, after) => db.doc(path).onSnapshot(s => { LIVE[key] = s.exists ? s.data() : null; if (after) after(); }, () => {});
    sub('feed/latest', 'feed', () => { renderLive(); renderHome(); });
    sub('status/run', 'status', () => { renderLive(); renderHome(); });
    sub('signals/latest', 'signals', () => { renderLive(); renderHome(); renderStocks(); if (selected) renderDetail(); if (VIEW === 'arena') renderArena(); });
    sub('correlations/latest', 'corr', renderCorr);
    sub('prices/latest', 'prices', () => { resolveCalls(); if (VIEW === 'arena') renderArena(); if (FOC.data) renderFocus(); });
    db.doc('focus/latest').onSnapshot(s => { FOC.data = s.exists ? s.data() : null; renderFocus(); renderHomeFocus(); }, () => {});
    db.doc('dossier/index').onSnapshot(s => { RES.index.pub = s.exists ? (s.data().items || []) : []; researchIndex(); if (VIEW === 'research' && !RES.key) renderResearch(); }, () => {});
    sub('calibration/links', 'cal', () => { CAL = {}; ((LIVE.cal && LIVE.cal.edges) || []).forEach(c => { CAL[c.s + '>' + c.t] = c; }); if (selected) renderDetail(); });
    db.doc('screen/latest').onSnapshot(s => { SCR.data = s.exists ? s.data() : null; renderScreen(); renderHome(); if (PF.holdings.length && STK.index) analysePortfolio(); }, () => {});
    db.doc('stocks/index').onSnapshot(s => { STK.index = s.exists ? s.data() : null; renderStocks(); if (PF.holdings.length && SCR.data) analysePortfolio(); if (STK.index && STK.current === null) { const f = STK.index.stocks.XOM ? 'XOM' : Object.keys(STK.index.stocks)[0]; $('#stockQ').value = f; openStock(f); } }, () => {});
    db.doc('stocks/factors').onSnapshot(s => { STK.factors = s.exists ? s.data() : null; STK.shards = {}; renderStocks(); }, () => {});
    if (ME.owner) db.doc('owner/dossier-index').onSnapshot(s => { RES.index.own = s.exists ? (s.data().items || []) : []; researchIndex(); if (VIEW === 'research' && !RES.key) renderResearch(); }, () => {});
    if (ME.owner) db.doc('owner/portfolio').onSnapshot(s => { OWN.data = s.exists ? s.data() : null; renderOwner(); renderHomePf(); renderPlayer(); renderFocus(); renderHomeFocus(); if (VIEW === 'arena') renderArena(); }, () => {});
    if (ME.uid) {
      G.ref = db.doc(`data/users/${ME.uid}/progress`);
      try { const snap = await G.ref.get(); if (snap.exists) { const d = snap.data(); if (d && d.v === 1 && (d.xp || 0) >= (PROG.xp || 0)) PROG = Object.assign(blank(), d); } else if (PROG.xp) save(); } catch (_) {}
      G.loaded = true; renderPlayer();
      RES.reqRef = db.doc(`data/users/${ME.uid}/requests`);
      RES.reqRef.onSnapshot(s => { RES.req = s.exists ? s.data() : null; if (VIEW === 'research' && RES.doc) { const a = $('#rActions'); if (a) renderResearch(); } }, () => {});
      PF.ref = db.doc(`data/users/${ME.uid}/portfolio`);
      try { const snap = await PF.ref.get(); if (snap.exists) { const d = snap.data(); $('#pfInput').value = d.text || ''; PF.holdings = Array.isArray(d.holdings) ? d.holdings : parseHoldings(d.text); } $('#pfStatus').textContent = 'Saved privately: only you can see it'; } catch (e) { $('#pfStatus').textContent = 'Private storage unavailable'; }
      analysePortfolio(); renderHomePf();
    }
    if (!ME.owner) { $('#ownerPf').innerHTML = '<div class="card flat"><p class="empty">Connect your platforms or upload a mutual fund statement with the button above to see your holdings, trades and the events behind your gains and losses here. Meanwhile, paste tickers below to see their exposure to the news.</p></div>'; $('#pfPaste').open = true; }
  })();

  // ======================= glossary: technical terms explain themselves on hover =======================
  const TERMS = {
    sigma: ['σ (sigma)', 'How unusual a move was: the move divided by its typical daily size. 1σ is an ordinary day, 3σ happens a few times a year, 7σ is extremely rare.'],
    corr: ['Correlation', 'From −1 to +1: how closely two things move together week to week. +1 always together, 0 no relation, −1 always opposite. For stocks it is measured on what their market and sector do not explain.'],
    prob: ['Chance of being higher', 'From a model retrained every year and tested only on years it had not seen. Around 50% is a coin flip; only rows that beat naive have shown any edge.'],
    naive: ['Beat naive', 'The naive forecast assumes the asset rises as often as it usually does. Beating it on unseen years is the bar for a model to have any real skill; most assets do not.'],
    auc: ['AUC', 'How well the model ranks the days that rose above the days that fell: 0.5 is a coin flip, 1.0 is perfect. Below about 0.53 means no useful signal.'],
    skill: ['Skill', 'The model’s Brier score compared with the naive forecast’s, on unseen years. Above zero means the model did better than naive.'],
    brier: ['Brier score', 'The squared gap between the chance you gave and what happened (1 if it rose, 0 if not). Lower is better: always saying 50% scores 0.25, a confident wrong call scores near 1.'],
    robust: ['Robust link', 'So strong that luck is very unlikely (t-statistic at least 4.5), and it kept the same sign in all three thirds of the history.'],
    likely: ['Likely link', 'Strong enough to be probably real (t-statistic at least 3) and the same sign in all three thirds of the history. Weaker than robust.'],
    hidden: ['Hidden exposure', 'A link this stock’s sector would not normally have, such as a paint maker that moves with crude oil.'],
    sens: ['Sensitivity', 'How much the stock tends to move, beyond its market and sector, when the factor moves 1% (or 0.1 point for interest rates).'],
    beta: ['Beta', 'How much it moves when the market moves 1%: 1.5× means about 1.5% for each 1% move.'],
    pressure: ['News pressure', 'How hard the last 14 days of logged events push this through the measured links, fading with a three-day half-life. Positive pushes up. It describes the news; it is not a forecast.'],
    focusscore: ['Focus score', 'Strength of this week’s news push compared with the strongest name on today’s list, which scores 100.'],
    linesup: ['Lines up', 'How many other signals point the same way as the news: the tested model (only where it beat naive), analyst consensus, and the price trend.'],
    tailwind: ['Tailwind and headwind', 'A tailwind means this week’s news pushes the asset up through its measured links; a headwind pushes it down.'],
    ma200: ['200-day average', 'The average closing price of the last 200 trading days. Trading above it is a common sign of an uptrend, below it of a downtrend.'],
    target: ['Analyst price target', 'The average 12-month price target analysts publish, compared with today’s price: +13% means the average target is 13% higher.'],
    vol: ['Volatility', 'How much the price swings, as the yearly standard deviation of returns. 40% means a typical year can swing about 40% either way.'],
    drawdown: ['Drawdown', 'The fall from the highest value in the period to the lowest point after it.'],
    exspx: ['After removing the S&P 500', 'The correlation left once both assets’ shared moves with the US stock market are taken out, so it shows a link of their own.'],
    leadlag: ['Lead by a week', 'Whether this week’s move in one asset says anything about next week’s move in the other. Near 0 means it does not.'],
    pvalue: ['p-value', 'The chance of a result this strong by luck alone. 0.05 is the usual bar; across thousands of tests it needs to be far lower.'],
    vix: ['VIX', 'The market’s fear gauge: expected S&P 500 swings over the next month. High VIX weeks are stressed markets, low VIX weeks calm ones.'],
    halflife: ['Half-life', 'An event’s pull halves every three days, so news from a week ago counts about a fifth as much as today’s.'],
    weight: ['Link weight', 'From 0 to 1: how strongly one item has moved the other in past episodes.'],
    baserate: ['Base rate', 'How often the target moves that way on an ordinary day. A link only counts if moves after shocks beat this rate.'],
    pe: ['Price to earnings', 'Share price divided by a year of earnings per share. Negative means the company lost money.'],
    pb: ['Price to book', 'Share price divided by the accounting value of the company per share.'],
    mcap: ['Market value', 'Share price times the number of shares: what the whole company is worth on the market.'],
    divy: ['Dividend yield', 'A year of dividends as a percentage of the share price.'],
    range52: ['52-week range', 'The lowest and highest prices of the past year.'],
    conf: ['How sure you are', 'From 50% (a coin flip) to 95%. Being very sure and wrong costs far more than being moderately sure and wrong.'],
    scale: ['Event size', 'Minor, notable or major, by how much the event could move markets. A major event counts about three times as much as a minor one.'],
    exposure: ['Exposure score', 'How strongly the last 14 days of events push this stock through its measured links, scaled so the strongest is 100.'],
    breakeven: ['To break even', 'How much the price must rise from here to get back to your average cost.'],
    shock: ['Shock', 'A move more than two standard deviations from normal, used to test whether one item really moves another.'],
  };
  const AUTO_TERMS = [
    [/\d*\.?\d*σ/, 'sigma'], [/\bAUC\b/, 'auc'], [/\bBrier\b/, 'brier'], [/\b[Cc]orrelations?\b|\bCorr\.|\bcorr\b/, 'corr'],
    [/\bbeat naive\b|\bno (?:tested|proven) (?:edge|skill)\b|\bnaive\b/i, 'naive'], [/\b200-day(?: average)?\b/, 'ma200'],
    [/\d+(?:\.\d+)?× (?:the market|its sector)/, 'beta'], [/\bbeta\b/, 'beta'], [/\b[Vv]olatility\b/, 'vol'],
    [/\bworst drop\b|\bfrom (?:its )?1-year high\b/, 'drawdown'], [/\bhalf-life\b/, 'halflife'], [/\b[Nn]ews pressure\b|\b[Ee]vent pressure\b|\bNews now\b/, 'pressure'],
    [/\bFocus score\b/, 'focusscore'], [/\blines? up with the news\b|\bline up\b/, 'linesup'], [/\b(?:Tailwinds?|Headwinds?)\b/, 'tailwind'],
    [/\bweight \d/, 'weight'], [/\d% base\b/, 'baserate'], [/\bp = /, 'pvalue'], [/\b[Aa]fter removing (?:the )?S&P 500\b|\bEx-S&P\b/, 'exspx'],
    [/\bleads? by a week\b/, 'leadlag'], [/\b(?:high|low) VIX\b|\bVIX\b/, 'vix'], [/\bPrice to earnings\b/, 'pe'], [/\bPrice to book\b/, 'pb'],
    [/\bMarket value\b/, 'mcap'], [/\bDividend yield\b/, 'divy'], [/\b52-week range\b/, 'range52'], [/\baverage target\b/, 'target'],
    [/\bSensitivity\b/, 'sens'], [/\bchance higher\b|\b[Uu]p in \d+ d(?:ays)?\b|\bModel, 20 days\b/, 'prob'], [/\bHow sure are you\b|\bSure\b(?= *$)/, 'conf'],
    [/\bTo break even\b/, 'breakeven'], [/\bshocks\b/, 'shock'], [/\bskill\b/, 'skill'],
  ];
  const TAG_TERMS = { robust: 'robust', likely: 'likely', hidden: 'hidden', major: 'scale', notable: 'scale', minor: 'scale', 'no proven skill': 'naive', 'no edge': 'naive', skill: 'naive', 'hidden link': 'hidden' };
  const GLOSS_SKIP = 'script,style,textarea,select,option,svg,button,a,.term,.nav,.mobnav,.crt,.gtip,.toast,h1,h2,.radar-tip,.brand,.where,input,label[for]';
  function wrapTerms(root) {
    if (!root || root.nodeType !== 1 || root.closest('.crt,.gtip,.toast,.nav,.mobnav,svg')) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n => { const p = n.parentElement; if (!p || !n.nodeValue || n.nodeValue.trim().length < 2 && !n.nodeValue.includes('σ')) return NodeFilter.FILTER_REJECT; return p.closest(GLOSS_SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } });
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(n => {
      let node = n;
      for (let guard = 0; guard < 6 && node && node.nodeValue; guard++) {
        let best = null;
        for (const [re, key] of AUTO_TERMS) { const m = re.exec(node.nodeValue); if (m && m[0] && (!best || m.index < best.i)) best = { i: m.index, len: m[0].length, key }; }
        if (!best) break;
        const mid = node.splitText(best.i), rest = mid.splitText(best.len);
        const span = document.createElement('span'); span.className = 'term'; span.dataset.term = best.key; span.tabIndex = 0; span.textContent = mid.nodeValue;
        mid.replaceWith(span); node = rest;
      }
    });
    (root.matches('.tag') ? [root] : []).concat([...root.querySelectorAll('.tag')]).forEach(t => {
      if (t.classList.contains('term') || t.closest('button,a')) return;
      const k = TAG_TERMS[t.textContent.trim().toLowerCase()]; if (k) { t.classList.add('term'); t.dataset.term = k; t.tabIndex = 0; }
    });
  }
  const GT = document.createElement('div'); GT.className = 'gtip'; GT.hidden = true; GT.setAttribute('role', 'tooltip'); GT.id = 'gtip'; document.body.appendChild(GT);
  let gtCur = null;
  function showTerm(el) {
    const t = TERMS[el.dataset.term]; if (!t) return;
    gtCur = el; GT.innerHTML = `<b>${esc(t[0])}</b><span>${esc(t[1])}</span>`; GT.hidden = false;
    el.setAttribute('aria-describedby', 'gtip');
    const r = el.getBoundingClientRect();
    placeTip(GT, null, document.documentElement, r.left + r.width / 2, r.top + r.height / 2, Math.max(r.width, r.height) / 2, 'tbrl', 10);
  }
  function hideTerm() { if (gtCur) gtCur.removeAttribute('aria-describedby'); gtCur = null; GT.hidden = true; }
  document.addEventListener('mouseover', ev => { const t = ev.target.closest && ev.target.closest('.term'); if (t) { if (t !== gtCur) showTerm(t); } else if (gtCur) hideTerm(); });
  document.addEventListener('focusin', ev => { const t = ev.target.closest && ev.target.closest('.term'); if (t) showTerm(t); else if (gtCur) hideTerm(); });
  document.addEventListener('click', ev => { const t = ev.target.closest && ev.target.closest('.term'); if (t) { if (gtCur === t && !GT.hidden) hideTerm(); else showTerm(t); } });
  window.addEventListener('scroll', () => { if (gtCur) hideTerm(); }, { passive: true });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && gtCur) hideTerm(); });
  const glossRoot = document.querySelector('.main');
  const glossObs = new MutationObserver(muts => {
    const roots = new Set();
    muts.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) roots.add(n); else if (n.nodeType === 3 && n.parentElement) roots.add(n.parentElement); }));
    if (!roots.size) return;
    glossObs.disconnect();
    roots.forEach(r => { if (r.isConnected) { try { wrapTerms(r); } catch (_) {} } });
    glossObs.observe(glossRoot, { childList: true, subtree: true });
  });
  wrapTerms(glossRoot);
  glossObs.observe(glossRoot, { childList: true, subtree: true });

  // ======================= boot =======================
  renderDetail(); renderLedger(); renderResults();
  const first = R.presets[0]; runShock(first.label, first.seeds.map(([id, dir]) => ({ id, dir })), first.k);
  route();
  if (!reduced) RAD.raf = requestAnimationFrame(loopRadar);
})();
