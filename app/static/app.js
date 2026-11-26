/* Well Watch UI. Ranking is computed here with FlagEngine (deterministic, no AI) from the gold snapshot, the safety view,
   tests/inspections and safety events. Engineers can log tests and events, update event status and define their own per-well
   fields, so a rule can track any safety measure. The assistant answers through /api/chat; every fact links to evidence,
   and every gold row can be traced to silver, bronze and the raw file through /api/lineage. */
(function () {
  const F = window.FlagEngine;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const clone = o => JSON.parse(JSON.stringify(o));
  const fmt = (v, d = 0) => v === null || v === undefined || v === '' || isNaN(Number(v)) ? '' : Number(v).toLocaleString('en-US', {minimumFractionDigits: d, maximumFractionDigits: d});
  // Lucide line icons (the Dakota design system's icon set), drawn inline so they take currentColor.
  const ICONS = {check: '<path d="M20 6 9 17l-5-5"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>', alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>', note: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>', arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    down: '<path d="m6 9 6 6 6-6"/>', up: '<path d="m18 15-6-6-6 6"/>', ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-14.93 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>', undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'};
  const ic = (n, cls = 'sm') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;
  const SAFETY_TAG = `<span class="shield">${'<svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true">'}${'<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>'}</svg>Safety</span>`;
  const store = {get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} }};
  const api = async (path, opts) => { const r = await fetch(path, opts); if (!r.ok) throw new Error((await r.text()).slice(0, 300) || r.statusText); return r.json(); };
  const post = (path, body, method = 'POST') => api(path, {method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const lin = o => `data-lin='${esc(JSON.stringify(o))}'`;

  let D = null, ENG = null, RULES = [], MODE = 'value', SAFETY_FIRST = true, WO_HANDLED = false, ACKS = {}, EST = {}, RANK = [], ITEMS = {test: [], event: []}, view = 'day', rulesSource = 'default', showAll = false;
  let wellSort = {k: 'score', dir: -1}, wellFilter = '', ruleFilter = 'All';
  let wellView = 'all', wellShowOk = false, wellDense = (() => { try { return localStorage.getItem('ww-dense') !== '0'; } catch (e) { return true; } })();
  const chat = {id: null, busy: false, evidence: {}};
  let SIM = null;  // demo: a simulated SCADA reading overlaid on one well

  // ---------------- load ----------------
  async function loadBundle() {
    D = await api('api/bundle');
    F.setCustomFields(D.custom_fields);
    const attrs = {}; for (const a of D.attributes) (attrs[a.well_id] = attrs[a.well_id] || {})[a.field_key] = a.value;
    const types = Object.fromEntries(D.custom_fields.map(c => [c.field_key, c.field_type]));
    for (const w of D.snapshot) for (const c of D.custom_fields) {
      const v = (attrs[w.well_id] || {})[c.field_key];
      w['x_' + c.field_key] = v === undefined || v === null || v === '' ? null : types[c.field_key] === 'number' ? Number(v) : types[c.field_key] === 'yesno' ? v === 'true' : v;
    }
    D.attrs = attrs; D.alert_tasks = D.alert_tasks || []; if (SIM) applySim(); ITEMS = D.items; D.settings = D.settings || {}; D.acks = D.acks || []; D.estimates = D.estimates || []; D.notes = D.notes || [];
    // notes that report a test or event not yet in the source system: confirmed when a matching record arrives, overdue after expected_by
    for (const n of D.notes) n.state = noteState(n);
    const byWell = {}; for (const n of D.notes) (byWell[n.well_id] = byWell[n.well_id] || []).push(n);
    for (const w of D.snapshot) { const ns = byWell[w.well_id] || [];
      w.notes_count = ns.length; w.pending_reports = ns.filter(n => n.state.s === 'waiting').length; w.unconfirmed_reports = ns.filter(n => n.state.s === 'overdue').length; }
  }
  async function init() {
    setTheme(document.documentElement.dataset.theme || 'light');
    $('#themebtn').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    try { await loadBundle(); } catch (e) {
      $('#main').innerHTML = `<div class="errcard"><b>The well data didn't load.</b><div>The app couldn't reach the Databricks SQL warehouse. It may be starting up; try again in a minute.</div>
        <div style="display:flex;gap:8px"><button class="btn" id="retry">Retry</button><button class="btn sec" id="copyerr">Copy error details</button></div></div>`;
      $('#retry').onclick = () => location.reload();
      $('#copyerr').onclick = () => { try { navigator.clipboard.writeText(String(e.message)); toast('Error details copied'); } catch (x) {} };
      return;
    }
    $('#chatmodel').textContent = 'model: ' + D.model.replace('databricks-', '');
    $('#eng').innerHTML = D.engineers.map(e => `<option value="${e.engineer_id}">${esc(e.engineer_name)}</option>`).join('');
    ENG = store.get('ww-eng') || D.engineers[0].engineer_id; $('#eng').value = ENG;
    $('#eng').onchange = () => { ENG = $('#eng').value; store.set('ww-eng', ENG); loadRules(); newChat(); render(); };
    document.querySelectorAll('nav button').forEach(b => b.onclick = () => go(b.dataset.v));
    $('#chatbtn').onclick = () => toggleChat(); $('#chatx').onclick = () => toggleChat(false); $('#chatnew').onclick = newChat;
    $('#send').onclick = send; $('#q').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
    $('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').hidden = true; };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('#modal').hidden) $('#modal').hidden = true; else if (!$('#editor').hidden) $('#editor').hidden = true; else $('#drawer').hidden = true; } });
    const rm = /^report\/([\w-]+)(?:\/(\w+))?/.exec((location.hash || '').slice(1));
    if (rm) { renderReport(rm[1], rm[2]); return; }
    loadRules(); newChat();
    $('#reportbtn').onclick = () => reportIncident();
    loadIncidents().then(() => { if (view === 'incidents') renderIncidents(); }); watchIncidents(true);
    const h = (location.hash || '').slice(1); if (['day', 'wells', 'safety', 'rules', 'alerts', 'incidents'].includes(h)) view = h;
    toggleChat(store.get('ww-chat') !== 'closed');
    render();
  }
  async function refresh(msg) {  // after an engineer logs something: reload data, rerank, rerender
    try { await loadBundle(); recompute(); render(); if (msg) toast(msg); } catch (e) { toast('Saved, but reload failed: ' + e.message); }
  }
  function loadRules() {
    const s = D.saved_rules[ENG];
    if (s) {
      RULES = s.rules; MODE = s.mode || 'value'; rulesSource = 'saved';
      // fill in groups and typical fix costs for starter rules saved before those existed
      for (const r of RULES) { if (r.group === undefined && F.GROUPS[r.id]) r.group = F.GROUPS[r.id]; if (r.fix_cost === undefined && F.FIX_COSTS[r.id]) r.fix_cost = F.FIX_COSTS[r.id]; }
      // rule sets saved before the safety pack existed get it added once
      if (!RULES.some(r => String(r.id).startsWith('SAFE_'))) RULES = clone(F.DEFAULT_RULES.filter(r => String(r.id).startsWith('SAFE_'))).concat(RULES);
      RULES = restoreLocked(RULES);
    } else { RULES = clone(F.DEFAULT_RULES); MODE = 'value'; rulesSource = 'default'; }
    const st = D.settings[ENG] || {};
    SAFETY_FIRST = true; // safety always ranks first; there is no setting to turn it off
    WO_HANDLED = !!st.wo_handled;
    recompute();
  }
  // Built-in safety rules are set by the operator: always on, never edited or deleted here. The server enforces the same on save.
  const LOCKED = new Map(F.DEFAULT_RULES.filter(F.isSafety).map(r => [r.id, r]));
  const isLocked = r => !!r && LOCKED.has(r.id);
  function restoreLocked(rules) {
    const out = rules.map(r => LOCKED.has(r.id) ? clone(LOCKED.get(r.id)) : r);
    for (const [id, r] of LOCKED) if (!out.some(x => x.id === id)) out.push(clone(r));
    return out;
  }
  function recompute() {
    ACKS = {}; EST = {};
    for (const a of D.acks.filter(a => a.engineer_id === ENG)) { let snap = {}; try { snap = JSON.parse(a.snapshot_json || '{}'); } catch (e) {} ACKS[a.well_id + '|' + a.rule_id] = Object.assign({}, a, snap); }
    for (const e of D.estimates.filter(e => e.engineer_id === ENG)) if (e.cost_cad !== null && e.cost_cad !== undefined) EST[e.well_id + '|' + e.rule_id] = e.cost_cad;
    RANK = F.rank(D.snapshot, RULES, D.today, MODE, ENG, ITEMS, {safetyFirst: SAFETY_FIRST, acks: ACKS, estimates: EST, woHandled: WO_HANDLED});
  }
  const ACTIVE = () => RANK.filter(r => r.tier !== 'handled');
  const SORT_LABEL = () => ({value: '$/day at risk', payback: 'fastest payback (fix cost ÷ $/day)', score: 'points'})[MODE] || '$/day at risk';
  const myWells = () => D.snapshot.filter(w => w.engineer_id === ENG);
  const myIds = () => new Set(myWells().map(w => w.well_id));
  const engName = () => (D.engineers.find(e => e.engineer_id === ENG) || {}).engineer_name;
  function go(v) { view = v; try { history.replaceState(null, '', '#' + v); } catch (e) {} render(); }
  // How current each source system is (gold_source_freshness). Amber when a source is older than it should be.
  function renderFreshness() {
    const now = new Date(D.now + 'Z');
    const rows = (D.freshness || []).map(f => { const age = (now - new Date(String(f.last_received).replace(' ', 'T') + (String(f.last_received).endsWith('Z') ? '' : 'Z'))) / 3600000;
      return Object.assign({}, f, {stale: age > Number(f.stale_after_hours), age}); });
    const short = {'SCADA production': 'Production', 'SCADA safety readings': 'Safety readings', 'Maintenance / integrity system': 'Tests', 'HSE incident system': 'Incidents', 'Field downtime log': 'Downtime', 'Accounting': 'Costs'};
    const md = d => { const x = new Date(String(d).slice(0, 10) + 'T00:00:00Z'); return x.toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'}); };
    $('#fresh').innerHTML = `<span class="muted">Data:</span> ${rows.map(f => `<span class="fr ${f.stale ? 'stale' : ''}" title="${esc(f.source)}: ${esc(f.provides)}. Data through ${esc(String(f.data_through).slice(0, 10))}; last received ${esc(String(f.last_received).slice(0, 16).replace('T', ' '))}.">${f.stale ? ic('alert') : ic('check')} ${esc(short[f.source] || f.source)} ${/Maintenance|HSE/.test(f.source) ? 'updated ' + md(f.last_received) : 'through ' + md(f.data_through)}</span>`).join('')}
      <a class="lk" id="freshmore">details</a>`;
    $('#freshmore').onclick = () => showModal(`<div class="mhead"><h2>Where the data comes from</h2><button class="btn sec close" id="mx">Close</button></div><div class="mbody">
      <div class="note">Each source system sends its data on a schedule. A source turns amber when its last delivery is older than expected, so numbers from it may be out of date.</div>
      <table><thead><tr><th>Source system</th><th>Provides</th><th>Data through</th><th>Last received</th><th>Status</th></tr></thead><tbody>${rows.map(f => `<tr><td><b>${esc(f.source)}</b></td><td>${esc(f.provides)}</td>
        <td>${esc(String(f.data_through).slice(0, 10))}</td><td>${esc(String(f.last_received).slice(0, 16).replace('T', ' '))}</td>
        <td>${f.stale ? `<span class="pill warn">late (${fmt(f.age, 0)} h old, expected within ${fmt(f.stale_after_hours)} h)</span>` : '<span class="pill ok">on time</span>'}</td></tr>`).join('')}</tbody></table></div>`);
  }
  function setTheme(t) {
    document.documentElement.dataset.theme = t; store.set('ww-theme', t);
    $('#themebtn').innerHTML = ic(t === 'dark' ? 'sun' : 'moon', '');
    $('#themebtn').title = t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  }
  function render() {
    renderFreshness();
    const titles = {day: 'My day', wells: 'My wells', safety: 'Safety', rules: 'Flag rules', alerts: 'Alerts', incidents: 'Safety incidents'};
    $('#ptitle').textContent = titles[view];
    $('#pmeta').innerHTML = `${esc(engName() || '')}<span class="sep" style="opacity:.5;padding:0 6px">·</span>${myWells().length} wells<span class="sep" style="opacity:.5;padding:0 6px">·</span>Data through ${esc(D.as_of)}`;
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === view));
    const ids = myIds();
    $('#c-day').textContent = Math.min(10, ACTIVE().length); $('#c-wells').textContent = ids.size; $('#c-rules').textContent = RULES.filter(r => r.enabled).length;
    $('#c-safety').textContent = RANK.filter(r => r.tier === 'safety').length;
    $('#c-alerts').textContent = needsAlert().length;
    renderSimBar();
    ({day: renderDay, wells: renderWells, safety: renderSafety, rules: renderRules, alerts: renderAlerts, incidents: renderIncidents})[view]();
  }
  function bindCommon(root = document) {
    root.querySelectorAll('[data-well]').forEach(a => a.onclick = () => openWell(a.dataset.well));
    root.querySelectorAll('[data-lin]').forEach(a => a.onclick = e => { e.stopPropagation(); lineage(JSON.parse(a.dataset.lin)); });
    root.querySelectorAll('[data-ask]').forEach(b => b.onclick = () => ask(`Why is ${b.dataset.ask} flagged, and what does the data show I should check first?`));
  }
  const itemLin = it => it.record_id ? {kind: 'test', bronze_id: it.record_id, focus_well: it.well_id} : it.event_id ? {kind: 'safety_event', bronze_id: it.event_id, focus_well: it.well_id} : null;
  let DRAWER_WELL = null;
  function noteState(n) {
    if (!n.pending_kind) return {s: 'note'};
    const since = String(n.created_at).slice(0, 10), want = String(n.pending_type || '').trim().toLowerCase();
    const match = n.pending_kind === 'test'
      ? ITEMS.test.find(t => t.well_id === n.well_id && String(t.test_type).toLowerCase() === want && String(t.last_test_date).slice(0, 10) >= since)
      : ITEMS.event.find(e => e.well_id === n.well_id && String(e.category).toLowerCase() === want && String(e.event_date).slice(0, 10) >= since);
    if (match) return {s: 'confirmed', rec: match};
    return {s: String(n.expected_by).slice(0, 10) < D.today ? 'overdue' : 'waiting'};
  }
  const noteBadge = n => ({note: '', waiting: `<span class="pill warn">waiting for the ${esc(n.pending_type)} record · expected by ${esc(String(n.expected_by).slice(0, 10))}</span>`,
    overdue: `<span class="pill crit">not in the ${n.pending_kind === 'test' ? 'maintenance' : 'HSE'} system yet · was expected by ${esc(String(n.expected_by).slice(0, 10))}</span>`,
    confirmed: `<span class="pill ok">${ic('check')} Confirmed by the official record</span>`})[n.state.s];
  const noteHtml = (n, withArchive) => `<div class="noteitem"><div>${esc(n.body)}</div>
    <div class="muted small">${esc(n.created_by || '')} · ${esc(String(n.created_at).slice(0, 16).replace('T', ' '))}${n.rule_id ? ` · on "${esc((RULES.find(r => r.id === n.rule_id) || {}).name || n.rule_id)}"` : ''} ${noteBadge(n)}
      ${n.state.rec ? `<a class="lk" ${lin(itemLin(n.state.rec))}>see record</a>` : ''}${withArchive ? ` · <a class="lk" data-arch="${n.note_id}">archive</a>` : ''}</div></div>`;
  function noteForm(p) {
    const w = D.snapshot.find(x => x.well_id === p.well_id), r = RANK.find(x => x.well_id === p.well_id);
    const testTypes = [...new Set(D.test_catalog.map(c => c.test_type).concat(ITEMS.test.filter(t => t.well_id === p.well_id).map(t => t.test_type)))];
    const cats = ['ESD trip', 'PSV lift', 'H2S alarm', 'Gas detector alarm', 'Spill', 'Gas release', 'Flowline failure', 'Fire', 'Electrical fault', 'Regulator non-compliance', 'Near miss'];
    formModal(`Add a note on ${p.well_id} · ${w.well_name}`, `<div class="note">Notes are context for you and other engineers (and the assistant). They are not official records: tests belong in the maintenance system and incidents in the HSE system.</div>
      <div class="frm"><div class="full"><label>Note</label><textarea id="n-body" placeholder="e.g. Operator says the H2S monitor has been glitchy since the cold snap; replacement sensor ordered">${esc(p.body || '')}</textarea></div>
      <div class="full"><label>About a flag (optional)</label><select id="n-rule"><option value="">The well in general</option>${(r ? r.flags : []).map(f => `<option value="${f.rule_id}" ${f.rule_id === p.rule_id ? 'selected' : ''}>${esc(f.rule_name)}</option>`).join('')}</select></div>
      <div class="full"><label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="n-pend"> This reports a test or event that isn't in the official system yet</label></div>
      <div id="n-pendbox" hidden style="grid-column:1/3"><div class="frm">
        <div><label>Waiting for a</label><select id="n-kind"><option value="test">test or inspection</option><option value="event">safety event</option></select></div>
        <div><label>Which one</label><input id="n-type" list="n-types" placeholder="e.g. Subsurface safety valve test"><datalist id="n-types">${testTypes.map(t => `<option value="${esc(t)}">`).join('')}</datalist></div>
        <div><label>Should be in the system by</label><input id="n-exp" type="date" value="${addDays(D.today, 3)}" min="${D.today}"></div>
        <div class="note" style="align-self:end">It is confirmed automatically when the matching record arrives. If it hasn't by this date, the well gets a reminder flag.</div></div></div></div>`, async () => {
        const pend = $('#n-pend').checked;
        await post('api/notes', {engineer_id: ENG, well_id: p.well_id, rule_id: val('n-rule') || null, body: val('n-body'),
          pending_kind: pend ? val('n-kind') : null, pending_type: pend ? val('n-type') : null, expected_by: pend ? val('n-exp') : null});
        $('#modal').hidden = true; await refresh('Note added'); if (DRAWER_WELL === p.well_id) openWell(p.well_id);
      });
    $('#n-pend').onchange = e => { $('#n-pendbox').hidden = !e.target.checked; };
    $('#n-kind').onchange = e => { $('#n-types').innerHTML = (e.target.value === 'test' ? testTypes : cats).map(t => `<option value="${esc(t)}">`).join(''); $('#n-type').value = ''; };
  }
  // Test status: red only when something is wrong. "Safety-critical" is a neutral label about the test's importance, not its result.
  const SC_LABEL = '<span class="sclabel" title="A test that must not be missed or failed. Says nothing about the result.">Safety-critical</span>';
  const testState = t => ['Fail', 'Serious'].includes(t.last_result) ? 0 : t.overdue ? 1 : t.days_until_due <= 30 ? 2 : t.last_result === 'Non-serious' ? 3 : 4;
  const testStatus = t => ({0: `<span class="pill crit">${ic('x')} ${t.last_result === 'Serious' ? 'Serious result' : 'Failed'}</span>`, 1: `<span class="pill crit">${ic('x')} ${t.days_overdue} d overdue</span>`,
    2: `<span class="pill warn">Due in ${t.days_until_due} d</span>`, 3: '<span class="pill warn">OK, monitor</span>', 4: `<span class="pill ok">${ic('check')} OK</span>`})[testState(t)];
  const TEST_LEGEND = `<div class="note" style="margin:-4px 0 8px"><span class="sclabel" style="margin-left:0">Safety-critical</span> means the test must not be missed or failed. It says nothing about the result. The Status column shows how the well is doing: <span class="pill ok">${ic('check')} OK</span> <span class="pill warn">Due soon</span> <span class="pill crit">${ic('x')} Overdue or failed</span></div>`;

  // ---------------- "Look here first": what to highlight when tracing a flagged well ----------------
  // A rule condition is on a snapshot/test/event field; the same quantity appears under other column names in the daily
  // gold, silver and bronze rows. 'same' = apply the rule's own threshold to that column; a function = custom test; null = shade the column only.
  const isZero = v => v !== null && v !== '' && Number(v) === 0;
  const RELATED = {
    h2s_ambient_max_7d_ppm: [['h2s_ambient_ppm_max', 'same']],
    casing_pct_of_maasp: [['casing_pct_of_maasp', 'same'], ['casing_psi', null], ['csg_psi', null], ['casing_psi_max_7d', null], ['prod_casing_maasp_psi', null]],
    casing_psi_max_7d: [['casing_psi', 'same'], ['csg_psi', 'same']], casing_psi_7d: [['casing_psi', 'same'], ['csg_psi', 'same']],
    casing_psi_change: [['casing_psi', null], ['csg_psi', null], ['casing_psi_7d', null]],
    sc_psi_max_7d: [['sc_psi', 'same']], sc_psi_change: [['sc_psi', null], ['sc_psi_max_7d', null], ['sc_pct_of_limit', null]],
    sc_pct_of_limit: [['sc_pct_of_limit', 'same'], ['sc_psi', null], ['surface_casing_limit_psi', null]],
    scvf_status: [['result_status', v => /serious|fail/i.test(String(v)) && !/non/i.test(String(v))], ['result', v => /serious|fail/i.test(String(v)) && !/non/i.test(String(v))], ['scvf_rate_m3d', null], ['result_value', null]],
    flowline_pct_of_maop: [['flowline_pct_of_maop', 'same'], ['flowline_psi_max', null], ['flowline_psi_max_7d', null], ['flowline_maop_psi', null]],
    flowline_psi_max_7d: [['flowline_psi_max', 'same']],
    vent_pct_of_limit: [['vent_gas_m3', null], ['vent_mtd_m3', null], ['vent_limit_m3_month', null]],
    perf_ratio_7d: [['oil_bbl', null], ['target_oil_bopd', null], ['oil_7d_bopd', null], ['target_7d_bopd', null], ['lost_oil_bopd', null]],
    water_cut_change_pts: [['water_cut', null], ['water_bbl', null], ['water_cut_7d_pct', null]], water_cut_7d_pct: [['water_cut', null], ['water_bbl', null]],
    gor_change_pct: [['gor_scf_bbl', null], ['gas_mcf', null], ['gas_vol', null], ['gor_7d', null]],
    consecutive_down_days: [['hours_on', isZero], ['hrs_on', isZero], ['uptime', isZero], ['open_event_category', null]],
    open_event_planned: [['planned', null], ['is_open', v => v === true || v === 'true']],
    downtime_events_14d: [['category', null], ['planned', null], ['hours_lost', null]],
    days_since_last_data: [['reported', v => v === false || v === 'false'], ['last_reported_date', null]],
    margin_per_boe: [['operating_margin_cad', v => Number(v) < 0], ['operating_margin_oct_cad', v => Number(v) < 0], ['loe_cad', null], ['loe_per_boe', null], ['netback_per_boe', null]],
    // test and event fields
    last_result: [['result_status', 'same'], ['result_original', v => /fail|serious/i.test(String(v)) && !/non/i.test(String(v))], ['result', v => /fail|serious/i.test(String(v)) && !/non/i.test(String(v))]],
    overdue: [['test_date', null], ['interval_months', null], ['next_due_date', null], ['days_until_due', v => Number(v) < 0]],
    days_until_due: [['days_until_due', 'same'], ['test_date', null], ['interval_months', null], ['next_due_date', null]],
    result_value: [['result_value', 'same']], test_type: [['test_type', null]],
    category: [['category', 'same'], ['event_type', null], ['event_type_original', null]],
    status: [['status', 'same']], reportable: [['reportable', 'same']], reported_to_regulator: [['reported_to_regulator', 'same']],
    days_ago: [['event_date', null], ['event_ts', null], ['days_ago', 'same']], planned: [['planned', 'same']],
  };
  function buildFocus(wellId, itemId) {
    const r = RANK.find(x => x.well_id === wellId); if (!r) return null;
    const focus = {cols: {}, notes: [], itemIds: new Set(), well: wellId};
    const add = (col, t) => { const k = col.toLowerCase(), cur = focus.cols[k];
      focus.cols[k] = {tests: (cur ? cur.tests : []).concat(t ? [t] : [])}; };
    for (const f of r.flags) {
      const rule = RULES.find(x => x.id === f.rule_id); if (!rule) continue;
      const ds = rule.dataset || 'well';
      if (itemId && f.items && !f.items.some(it => (it.record_id || it.event_id) === itemId)) continue;
      if (f.items) f.items.forEach(it => focus.itemIds.add(it.record_id || it.event_id));
      focus.notes.push(f);
      rule.conditions.forEach((cn, i) => {
        if (ds === 'well' && f.evidence[i] && !f.evidence[i].matched) return;   // only the conditions that actually fired
        const same = v => F.matchValue(cn, v, ds, D.today);
        add(cn.field, same);
        for (const [col, t] of RELATED[cn.field] || []) add(col, t === 'same' ? same : t);
      });
    }
    return focus.notes.length ? focus : null;
  }
  const hitCell = (fc, v) => !!fc && v !== null && v !== undefined && v !== '' && fc.tests.some(t => { try { return t(v); } catch (e) { return false; } });
  function focusBanner(fx) {
    if (!fx) return '';
    return `<div class="lookfirst"><b>Look at these first</b> · why ${esc(fx.well)} is flagged
      ${fx.notes.map(f => `<div style="margin-top:4px"><span class="sev ${f.severity}" style="display:inline-block;margin-right:6px">${f.severity}</span>${f.safety ? SAFETY_TAG : ''}<b>${esc(f.rule_name)}</b> · ${esc(f.message)}${f.handled ? ' <span class="muted">(being handled)</span>' : ''}</div>`).join('')}
      <div class="small" style="margin-top:6px"><span class="fhit" style="padding:0 5px">red</span> = this value crossed the rule's threshold · <span class="fcol" style="padding:0 5px">shaded</span> = the columns behind the flag. Highlighted fields are listed first.</div></div>`;
  }

  // ---------------- My day ----------------
  function renderDay() {
    const mine = myWells(), act = ACTIVE(), handled = RANK.filter(r => r.tier === 'handled');
    const saf = act.filter(r => r.tier === 'safety').length, prod = act.filter(r => r.tier === 'production');
    const var_ = prod.reduce((s, r) => s + r.value, 0), oil = mine.reduce((s, w) => s + (w.oil_7d_bopd || 0), 0), tgt = mine.reduce((s, w) => s + (w.target_7d_bopd || 0), 0);
    const list = showAll ? act : act.slice(0, 10);
    const head = {safety: ['Safety', 'Deal with these first, most severe first.'], production: ['Production and cost', `Ranked by ${SORT_LABEL()}.`], watch: ['Watch list', 'Review-level items, by points.']};
    let last = null;
    $('#main').innerHTML = `<div class="kpis six">
        <div class="kpi"><div class="n">${mine.length}</div><div class="l">Wells assigned to ${esc(engName())}</div></div>
        <div class="kpi crit"><div class="n">${saf}</div><div class="l">Wells with a safety issue</div></div>
        <div class="kpi warn"><div class="n">${prod.length}</div><div class="l">Wells losing production or money</div></div>
        <div class="kpi"><div class="n">$${fmt(var_)}</div><div class="l">At risk per day on those wells</div></div>
        <div class="kpi"><div class="n">${handled.length}</div><div class="l">Marked as being handled</div></div>
        <div class="kpi"><div class="n">${fmt(oil)}</div><div class="l">Oil, last 7 days, bbl/d (type curve ${fmt(tgt)})</div></div></div>
      <div class="bar"><b style="font-size:16px">${showAll ? 'Everything that needs attention' : 'Top 10 to look at today'}</b>
        <span class="note">${SAFETY_FIRST ? 'Safety first, then production and cost by ' + SORT_LABEL() : 'Ranked by ' + SORT_LABEL()}, then the watch list · related rules count once · <a class="lk" id="torules">change rules</a></span>
        ${act.length > 10 ? `<button class="btn sec small" id="more" style="margin-left:auto">${showAll ? 'Show top 10' : `Show all ${act.length}`}</button>` : ''}</div>
      <div class="card">${list.length ? list.map((r, i) => { const t = r.tier !== last ? `<div class="tier">${head[r.tier][0]} <span style="text-transform:none;letter-spacing:0;font-weight:400;color:var(--dk-on-surface-muted)">· ${head[r.tier][1]}</span></div>` : ''; last = r.tier; return t + wellCard(r, i + 1); }).join('')
        : '<div class="empty">Nothing needs attention under your current rules.</div>'}</div>
      ${!showAll && act.length > 10 ? `<div class="note" style="margin-top:8px">${act.length - 10} more below the top 10: ${act.slice(10).map(r => `<a class="lk" data-well="${r.well_id}">${r.well_id}</a>`).join(', ')}</div>` : ''}
      ${handled.length ? `<h3>Being handled (${handled.length}) <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· off the list until the date passes, or sooner if the problem gets worse</span></h3>
        <div class="card">${handled.map(r => `<div class="wcard"><div class="rk"></div><div><div class="t"><a data-well="${r.well_id}">${r.well_id} · ${esc(r.fact.well_name)}</a></div></div><div></div>${r.flags.map(flagHtml).join('')}</div>`).join('')}</div>` : ''}`;
    $('#torules').onclick = () => go('rules');
    if ($('#more')) $('#more').onclick = () => { showAll = !showAll; render(); };
    bindCommon($('#main')); bindFlagActions($('#main'));
    document.querySelectorAll('[data-trace-snap]').forEach(a => a.onclick = () => lineage({kind: F.isSafety({category: a.dataset.cat}) ? 'safety_snapshot' : 'snapshot', well_id: a.dataset.traceSnap}));
  }
  function flagHtml(f) {
    const chips = f.items ? f.evidence.map(e => `<span class="chip hit lk2" ${lin(itemLin(e.item))} title="Trace this record">${esc(e.value)}</span>`).join('')
      : f.evidence.map(e => `<span class="chip ${e.matched ? 'hit' : ''}">${esc(e.label)}: ${esc(e.value)}</span>`).join('');
    const key = esc(JSON.stringify({w: f.well_id, r: f.rule_id}));
    const h = f.handled, ih = f.in_hand, meta = [];
    if (!h) meta.push(`${f.weight} pts${f.counted === false ? ` <span class="muted">(not added: counted once with "${esc(f.counted_with)}")</span>` : ''}`);
    if (!h && f.fix_cost !== null && f.fix_cost !== undefined) meta.push(`fix ≈ $${fmt(f.fix_cost)} <span class="muted">(${esc(f.fix_cost_source)})</span>`);
    const acts = (h ? (h.type === 'ack' ? `<a class="lk" data-unack='${key}'>no longer being handled</a>` : '')
      : ih ? `${alertable(f) ? `<a class="lk" data-alert='${key}'>${ic('flag')} draft alert</a> · ` : ''}<a class="lk" data-report='${key}'>report safety incident</a> · <a class="lk" data-unack='${key}'>clear who is handling it</a>`
      : `${alertable(f) ? `<a class="lk" data-alert='${key}'>${ic('flag')} draft alert</a> · ` : ''}${f.safety ? `<a class="lk" data-report='${key}'>report safety incident</a> · ` : ''}<a class="lk" data-ack='${key}'>${f.safety ? 'record who is handling it' : 'mark as being handled'}</a>${!f.safety ? ` · <a class="lk" data-est='${key}'>${EST[f.well_id + '|' + f.rule_id] !== undefined ? 'change' : 'add'} fix cost estimate</a>` : ''}`) + ` · <a class="lk" data-note='${key}'>add note</a>`;
    const fnotes = D.notes.filter(n => n.well_id === f.well_id && n.rule_id === f.rule_id);
    return `<div class="flag" style="${h ? 'opacity:.6' : ''}"><span class="sev ${f.severity}">${f.severity}</span><div class="msg">${F.isSafety(f) ? SAFETY_TAG : ''}${f.resurfaced ? `<span class="shield back">${ic('undo')}Back on the list</span>` : ''}<b>${esc(f.rule_name)}</b> · ${esc(f.message)}</div>
      ${f.resurfaced ? `<div class="act" style="color:var(--dk-status-amber)">Back on the list: ${esc(f.resurfaced)}.</div>` : ''}
      ${ih ? `<div class="act"><b>Being handled</b>${ih.owner ? ` by <b>${esc(ih.owner)}</b>` : ''} · follow up by ${esc(String(ih.until).slice(0, 10))} <span class="muted">(recorded by ${esc(ih.by || '')})</span>${ih.note ? ` · ${esc(ih.note)}` : ''}. <span class="muted">Safety flags stay on the list until the reading clears.</span></div>` : ''}
      ${h ? `<div class="act"><b>Being handled</b>${h.type === 'ack' ? `${h.owner ? ` by <b>${esc(h.owner)}</b>` : ''} · follow up by ${esc(String(h.until).slice(0, 10))} <span class="muted">(marked by ${esc(h.by || '')})</span>` : ' (open work order)'}${h.note ? ` · ${esc(h.note)}` : ''}</div>` : ''}
      ${fnotes.length ? `<div class="act">${fnotes.map(n => `${ic('note')} ${esc(n.body)} <span class="muted">· ${esc(n.created_by || '')}</span> ${noteBadge(n)}`).join('<br>')}</div>` : ''}
      <div class="chips">${chips}</div>${f.action && !h ? `<div class="act">Next step: ${esc(f.action)}</div>` : ''}
      <div class="act small">${meta.join(' · ')}${meta.length ? ' · ' : ''}${acts}</div></div>`;
  }
  function wellCard(r, n) {
    const w = r.fact;
    const side = r.tier === 'production'
      ? `<div class="score">$${fmt(r.value)}/day</div><div class="val">${r.value_parts.operating_loss ? `$${fmt(r.value_parts.lost_oil)} lost oil + $${fmt(r.value_parts.operating_loss)} operating loss` : 'lost oil vs type curve'}</div>
         <div class="val">${r.fix_cost ? `fix ≈ $${fmt(r.fix_cost)}${r.payback_days ? ` · pays back in ~${fmt(r.payback_days)} days` : ''}` : 'no fix cost estimate'}</div><div class="val">${r.score} pts</div>`
      : r.tier === 'safety' ? `<div class="score" style="color:var(--dk-status-bad)">${r.safety_worst}</div><div class="val">${r.safety_score} safety pts · ${r.score} total</div>`
      : `<div class="score">${r.score} pts</div>`;
    return `<div class="wcard"><div class="rk">${n}</div>
      <div><div class="t"><a data-well="${w.well_id}">${w.well_id} · ${esc(w.well_name)}</a></div>
        <div class="meta">${esc(w.reservoir)} · ${esc(w.lift_type)} · ${esc(w.area)} · ${esc(w.sour_class || '')} · ${fmt(w.oil_7d_bopd, 1)} bbl/d vs ${fmt(w.target_7d_bopd, 1)} type curve${Number(w.open_work_orders) > 0 ? ` · open work order: ${esc(w.open_work_order)}` : ''}</div></div>
      <div class="side">${side}</div>
      ${r.flags.map(flagHtml).join('')}
      ${(() => { const gen = D.notes.filter(n => n.well_id === w.well_id && !n.rule_id); return gen.length ? `<div class="flag"><span></span><div class="act">${ic('note')} ${esc(gen[0].body)} <span class="muted">· ${esc(gen[0].created_by || '')}</span>${gen.length > 1 ? ` <span class="muted">(+${gen.length - 1} more note${gen.length > 2 ? 's' : ''})</span>` : ''}</div></div>` : ''; })()}
      <div class="wactions"><button class="btn sec small" data-well="${w.well_id}">Open well</button><button class="btn sec small" data-ask="${w.well_id}">Ask why</button>
        <button class="btn sec small" data-trace-snap="${w.well_id}" data-cat="${esc(r.flags[0].category)}">Trace these numbers</button></div></div>`;
  }
  function bindFlagActions(root) {
    const find = k => { const {w, r} = JSON.parse(k); const rr = RANK.find(x => x.well_id === w); return {rk: rr, f: rr && rr.flags.find(f => f.rule_id === r), rule: RULES.find(x => x.id === r)}; };
    root.querySelectorAll('[data-ack]').forEach(a => a.onclick = e => { e.stopPropagation(); ackForm(find(a.dataset.ack)); });
    root.querySelectorAll('[data-unack]').forEach(a => a.onclick = async e => { e.stopPropagation(); const {f} = find(a.dataset.unack);
      await post('api/acks', {engineer_id: ENG, well_id: f.well_id, rule_id: f.rule_id, cleared: true}); await refresh('Back on the list'); });
    root.querySelectorAll('[data-est]').forEach(a => a.onclick = e => { e.stopPropagation(); estForm(find(a.dataset.est)); });
    root.querySelectorAll('[data-alert]').forEach(a => a.onclick = e => { e.stopPropagation(); openAlert(find(a.dataset.alert).f); });
    root.querySelectorAll('[data-report]').forEach(a => a.onclick = e => { e.stopPropagation(); const {f, rule} = find(a.dataset.report);
      const g = String((rule && rule.group) || '') + ' ' + f.rule_id;
      const category = /H2S/i.test(g) ? 'H2S release or alarm' : /Releases|SPILL/i.test(g) ? 'Spill or release' : /GAS_RELEASE|vent/i.test(g) ? 'Gas release' : 'Equipment failure';
      reportIncident({well_id: f.well_id, category, source_rule_id: f.rule_id, text: `Flag: ${f.rule_name}. ${f.message} `}); });
    root.querySelectorAll('[data-note]').forEach(a => a.onclick = e => { e.stopPropagation(); const {w, r} = JSON.parse(a.dataset.note); noteForm({well_id: w, rule_id: r}); });
  }
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  function ackForm({rk, f, rule}) {
    const wo = Number(rk.fact.open_work_orders) > 0 ? rk.fact.open_work_order : '';
    formModal(`${f.safety ? 'Record who is handling it' : 'Mark as being handled'}: ${f.rule_name} on ${f.well_id}`, `<div class="note">${f.safety ? '<b>Safety flag: it stays on the list, ranked as before, until the reading clears.</b> This records who is handling it and how, so everyone can see it. A note is required.' : `It leaves the list until the follow-up date. It comes back sooner if it gets worse${f.items ? ' (a new matching record appears)' : ' (a condition moves more than 10% further past its threshold)'}.`}</div>
      <div class="frm"><div><label>Who is handling it</label><input id="a-owner" list="a-owners" placeholder="e.g. Field ops (North), Integrity team"><datalist id="a-owners">${['Field ops', 'Production engineer', 'Integrity team', 'HSE', 'Maintenance', 'Service rig contractor', 'Electrician'].map(o => `<option value="${o}">`).join('')}</datalist></div>
      <div><label>Follow up by</label><input id="a-until" type="date" min="${D.today}" max="${addDays(D.today, 30)}" value="${addDays(D.today, 7)}"></div>
      <div class="full"><label>Note${f.safety ? ' (required)' : ''}</label><textarea id="a-note" placeholder="e.g. Pump change booked for Nov 26, Rig 4">${esc(wo ? 'Open work order ' + wo : '')}</textarea></div></div>`, async () => {
        if (f.safety && !val('a-note').trim()) throw new Error('Add a note on who is handling it and how.');
        if (!val('a-owner').trim()) throw new Error('Say who is handling it.');
        await post('api/acks', {engineer_id: ENG, well_id: f.well_id, rule_id: f.rule_id, until_date: val('a-until'), note: val('a-note'), owner: val('a-owner'), safety: !!f.safety, snapshot: F.ackSnapshot(f, rule, rk.fact)});
        $('#modal').hidden = true; await refresh(f.safety ? 'Recorded who is handling it; the safety flag stays on the list' : 'Marked as being handled');
      });
  }
  function estForm({f, rule}) {
    const cur = EST[f.well_id + '|' + f.rule_id];
    formModal(`Fix cost estimate: ${f.rule_name} on ${f.well_id}`, `<div class="note">Used to rank production problems by payback (cost ÷ $/day at risk). The rule's default is ${rule.fix_cost ? '$' + fmt(rule.fix_cost) : 'not set'}. Leave empty to use it.</div>
      <div class="frm"><div><label>Estimated cost to fix (CAD)</label><input id="x-cost" value="${cur ?? ''}" placeholder="${rule.fix_cost || ''}"></div><div></div>
      <div class="full"><label>Note</label><textarea id="x-note" placeholder="e.g. Quote from service company, rod job only"></textarea></div></div>`, async () => {
        const c = val('x-cost').replace(/[$,\s]/g, ''); if (c !== '' && isNaN(Number(c))) throw new Error('Enter a dollar amount, or leave it empty.');
        await post('api/estimates', {engineer_id: ENG, well_id: f.well_id, rule_id: f.rule_id, cost_cad: c, note: val('x-note')});
        $('#modal').hidden = true; await refresh('Estimate saved');
      });
  }

  // ---------------- My wells ----------------
  function renderWells() {
    const act = ACTIVE();
    const sc = Object.fromEntries(RANK.map(r => [r.well_id, {score: r.score, rank: act.indexOf(r) + 1 || '', worst: r.worst, n: r.flags.length, safety: r.safety_worst, tier: r.tier}]));
    const cols = [['well_id', 'Well'], ['score', 'Score', 1], ['perf_ratio_7d', 'vs type curve', 1], ['oil_7d_bopd', 'Oil bbl/d', 1], ['water_cut_7d_pct', 'Water cut %', 1],
      ['casing_pct_of_maasp', 'Casing % MAASP', 1], ['sc_psi_max_7d', 'Surf. csg psi', 1], ['h2s_ambient_max_7d_ppm', 'H2S ppm', 1], ['tests_overdue', 'Tests overdue', 1],
      ['open_safety_events', 'Open events', 1], ['uptime_14d_pct', 'Uptime %', 1], ['value_at_risk_cad_day', 'At risk $/d', 1]];
    let rows = myWells().map(w => Object.assign({}, w, {score: sc[w.well_id]?.score || 0, _f: sc[w.well_id]}));
    if (wellFilter) { const q = wellFilter.toLowerCase(); rows = rows.filter(w => [w.well_id, w.well_name, w.reservoir, w.lift_type, w.area, w.sour_class].join(' ').toLowerCase().includes(q)); }
    const grp = w => !w._f || !w._f.n ? 'none' : w._f.tier;
    const views = [['all', 'All'], ['flagged', 'Flagged'], ['safety', 'Safety'], ['production', 'Production'], ['watch', 'Watch list'], ['handled', 'Being handled'], ['none', 'No flags']];
    const base = rows, count = v => v === 'all' ? base.length : v === 'flagged' ? base.filter(w => grp(w) !== 'none').length : base.filter(w => grp(w) === v).length;
    if (wellView === 'flagged') rows = rows.filter(w => grp(w) !== 'none');
    else if (wellView !== 'all') rows = rows.filter(w => grp(w) === wellView);
    rows.sort((a, b) => { const x = a[wellSort.k], y = b[wellSort.k]; return (x === y ? 0 : x === null ? 1 : y === null ? -1 : x > y ? 1 : -1) * wellSort.dir; });
    // In "All", sorted by score, wells with no flags fold into one row at the bottom.
    const fold = wellView === 'all' && wellSort.k === 'score' && wellSort.dir < 0 && !wellFilter && !wellShowOk;
    const okRows = fold ? rows.filter(w => grp(w) === 'none') : [];
    const shown = fold ? rows.filter(w => grp(w) !== 'none') : rows;
    const meta = w => `${esc(w.reservoir)} · ${esc(w.lift_type)} · ${esc(w.sour_class)}`;
    const row = w => `<tr class="click" data-well="${w.well_id}"><td><b>${w.well_id}</b> ${esc(w.well_name)}${wellDense ? ` <span class="muted small">${meta(w)}</span>` : `<div class="muted small">${meta(w)}</div>`}</td>
        <td class="n">${w._f ? `<b>${w.score}</b> <span class="muted small">#${w._f.rank}</span>` : '<span class="muted">0</span>'}</td>
        <td class="n">${fmt(w.perf_ratio_7d, 2)}×</td><td class="n">${fmt(w.oil_7d_bopd, 1)}</td><td class="n">${fmt(w.water_cut_7d_pct, 1)}</td>
        <td class="n">${fmt(w.casing_pct_of_maasp, 0)}%</td><td class="n">${fmt(w.sc_psi_max_7d, 0)}</td><td class="n">${fmt(w.h2s_ambient_max_7d_ppm)}</td><td class="n">${fmt(w.tests_overdue)}</td>
        <td class="n">${fmt(w.open_safety_events)}</td><td class="n">${fmt(w.uptime_14d_pct, 1)}</td><td class="n">${fmt(w.value_at_risk_cad_day)}</td>
        <td>${w._f && w._f.tier === 'handled' ? '<span class="pill">being handled</span>' : w._f && w._f.n ? `${w._f.safety && w._f.safety !== 'Review' ? SAFETY_TAG : ''}<span class="pill ${w._f.worst === 'Critical' ? 'crit' : w._f.worst === 'Warning' ? 'warn' : 'rev'}">${w._f.n} flag${w._f.n > 1 ? 's' : ''}</span>` : '<span class="pill ok">OK</span>'}</td></tr>`;
    const total = shown.length + okRows.length;
    $('#main').innerHTML = `<div class="bar wbar"><input id="wf" placeholder="Filter by well, reservoir, lift, area, sour class" value="${esc(wellFilter)}" style="width:300px">
        <div class="filt">${views.map(([v, l]) => { const c = count(v); return (c || v === 'all' || v === wellView) ? `<button data-wv="${v}" class="${wellView === v ? 'on' : ''}">${l} ${c}</button>` : ''; }).join('')}</div>
        <div class="seg" style="margin-left:auto"><button data-dense="1" class="${wellDense ? 'on' : ''}">Compact</button><button data-dense="0" class="${wellDense ? '' : 'on'}">Comfortable</button></div></div>
      <div class="note" style="margin:0 0 8px">${total} wells · click a column to sort · click a well to open it${fold && okRows.length ? ' · wells with no flags are folded at the bottom' : ''}</div>
      <div class="card wtable${wellDense ? ' dense' : ''}"><table><thead><tr>${cols.map(([k, l, n]) => `<th class="s ${n ? 'n' : ''}" data-k="${k}">${l}${wellSort.k === k ? (wellSort.dir < 0 ? ' ' + ic('down') : ' ' + ic('up')) : ''}</th>`).join('')}<th>Flags</th></tr></thead>
      <tbody>${shown.map(row).join('')}${okRows.length ? `<tr class="foldrow" id="showok"><td colspan="${cols.length + 1}">${ic('check')} <b>${okRows.length} wells with no flags</b> <span class="muted">· nothing to look at today</span> <a class="lk">Show them</a></td></tr>` : ''}
      ${!shown.length && !okRows.length ? `<tr><td colspan="${cols.length + 1}" class="muted">No wells match.</td></tr>` : ''}</tbody></table></div>`;
    $('#wf').oninput = e => { wellFilter = e.target.value; const pos = e.target.selectionStart; renderWells(); $('#wf').focus(); $('#wf').setSelectionRange(pos, pos); };
    document.querySelectorAll('th.s').forEach(th => th.onclick = () => { const k = th.dataset.k; wellSort = {k, dir: wellSort.k === k ? -wellSort.dir : (k === 'well_id' ? 1 : -1)}; renderWells(); });
    document.querySelectorAll('[data-wv]').forEach(b => b.onclick = () => { wellView = b.dataset.wv; renderWells(); });
    document.querySelectorAll('[data-dense]').forEach(b => b.onclick = () => { wellDense = b.dataset.dense === '1'; try { localStorage.setItem('ww-dense', wellDense ? '1' : '0'); } catch (e) {} renderWells(); });
    const so = $('#showok'); if (so) so.onclick = () => { wellShowOk = true; renderWells(); };
    bindCommon($('#main'));
  }

  // ---------------- Safety ----------------
  function renderSafety() {
    const ids = myIds(), name = id => (D.snapshot.find(w => w.well_id === id) || {}).well_name || '';
    const tests = ITEMS.test.filter(t => ids.has(t.well_id));
    const overdue = tests.filter(t => t.overdue).sort((a, b) => (b.safety_critical - a.safety_critical) || (a.days_until_due - b.days_until_due));
    const soon = tests.filter(t => !t.overdue && t.days_until_due <= 30).sort((a, b) => a.days_until_due - b.days_until_due);
    const failed = tests.filter(t => ['Fail', 'Serious'].includes(t.last_result));
    const events = ITEMS.event.filter(e => ids.has(e.well_id));
    const open = events.filter(e => e.status !== 'Closed').sort((a, b) => String(b.event_date).localeCompare(String(a.event_date)));
    const recent = events.filter(e => e.days_ago <= 30 && e.status === 'Closed').sort((a, b) => String(b.event_date).localeCompare(String(a.event_date)));
    const safeWells = RANK.filter(r => r.flags.some(f => F.isSafety(f) && !f.handled));
    const testRow = t => `<tr><td><a class="lk" data-well="${t.well_id}">${t.well_id}</a> <span class="muted small">${esc(name(t.well_id))}</span></td><td>${esc(t.test_type)} ${t.safety_critical ? SC_LABEL : ''}</td>
      <td>${esc(String(t.last_test_date).slice(0, 10))} · ${esc(t.last_result)}</td><td>${testStatus(t)}</td>
      <td style="white-space:nowrap"><a class="lk" ${lin(itemLin(t))}>trace</a></td></tr>`;
    const evRow = e => `<tr><td>${esc(String(e.event_date).slice(0, 10))}</td><td><a class="lk" data-well="${e.well_id}">${e.well_id}</a></td><td><b>${esc(e.category)}</b><div class="muted small">${esc(e.description || '')}</div></td>
      <td>${e.reportable ? (e.reported_to_regulator ? `<span class="pill ok">${ic('check')} Reported</span>` : `<span class="pill crit">${ic('x')} Not reported</span>`) : '<span class="muted small">Not flagged reportable in HSE system</span>'}</td>
      <td style="white-space:nowrap"><a class="lk" ${lin(itemLin(e))}>trace</a></td></tr>`;
    const tblT = (head, rows, empty) => rows.length ? TEST_LEGEND.replace('margin:-4px 0 6px', 'margin:6px 12px') + tbl(head, rows, empty) : tbl(head, rows, empty);
    const tbl = (head, rows, empty) => rows.length ? `<div class="tw" style="max-height:320px;border:0"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<div class="muted small" style="padding:10px 12px">${empty}</div>`;
    $('#main').innerHTML = `<div class="bar"><span class="note" style="max-width:900px">Tests come from the <b>maintenance / integrity system</b> and incidents from the <b>HSE incident system</b>, recorded by field and safety staff. This tab is read-only: to correct a record, fix it in that system. Whether an event must be reported to the regulator is decided by a qualified person; this tab only shows what the HSE system records. To add context, write a <b>note</b> on the well; for a value the systems don't carry, add a <b>custom field</b>.</span>
        <button class="btn sec" id="bfields" style="margin-left:auto">Custom fields (${D.custom_fields.length})</button></div>
      <div class="kpis six">
        <div class="kpi crit"><div class="n">${safeWells.filter(r => r.safety_worst === 'Critical').length}</div><div class="l">Wells with a critical safety flag</div></div>
        <div class="kpi crit"><div class="n">${overdue.filter(t => t.safety_critical).length}</div><div class="l">Safety-critical tests overdue</div></div>
        <div class="kpi warn"><div class="n">${overdue.length}</div><div class="l">Tests and inspections overdue</div></div>
        <div class="kpi"><div class="n">${soon.length}</div><div class="l">Due in the next 30 days</div></div>
        <div class="kpi crit"><div class="n">${open.length}</div><div class="l">Open safety events</div></div>
        <div class="kpi crit"><div class="n">${events.filter(e => e.reportable && !e.reported_to_regulator).length}</div><div class="l">Flagged reportable, not yet reported</div></div></div>
      <div class="secgrid">
        <div class="card"><h4>Wells with safety flags <span class="muted small">${safeWells.length}</span></h4>
          ${tbl(['Well', 'Safety flags'], safeWells.map(r => `<tr><td><a class="lk" data-well="${r.well_id}">${r.well_id}</a><div class="muted small">${esc(r.fact.well_name)}</div></td>
            <td>${r.flags.filter(f => F.isSafety(f) && !f.handled).map(f => `<div><span class="sev ${f.severity}" style="display:inline-block;margin-right:6px">${f.severity}</span>${esc(f.rule_name)} <span class="muted small">· ${esc(f.message)}</span></div>`).join('')}</td></tr>`), 'No safety flags from your rules.')}</div>
        <div class="card"><h4>Open safety events <span class="muted small">${open.length}</span></h4>${tbl(['Date', 'Well', 'Event', 'Regulator', ''], open.map(evRow), 'No open events.')}</div>
        <div class="card"><h4>Overdue tests and inspections <span class="muted small">${overdue.length}</span></h4>${tblT(['Well', 'Test', 'Last done · result', 'Status', ''], overdue.map(testRow), 'Nothing overdue.')}</div>
        <div class="card"><h4>Failed tests <span class="muted small">${failed.length}</span></h4>${tblT(['Well', 'Test', 'Last done · result', 'Status', ''], failed.map(testRow), 'No failed tests.')}</div>
        <div class="card"><h4>Due in the next 30 days <span class="muted small">${soon.length}</span></h4>${tblT(['Well', 'Test', 'Last done · result', 'Status', ''], soon.map(testRow), 'Nothing due soon.')}</div>
        <div class="card"><h4>Closed in the last 30 days <span class="muted small">${recent.length}</span></h4>${tbl(['Date', 'Well', 'Event', 'Regulator', ''], recent.map(evRow), 'None.')}</div>
      </div>`;
    $('#bfields').onclick = fieldsManager;
    bindCommon($('#main'));
  }
  const wellOptions = sel => myWells().map(w => `<option value="${w.well_id}" ${w.well_id === sel ? 'selected' : ''}>${w.well_id} · ${esc(w.well_name)}</option>`).join('');
  function formModal(title, body, onSave) {
    showModal(`<div class="mhead"><h2>${esc(title)}</h2><button class="btn sec close" id="mx">Cancel</button></div><div class="mbody">${body}
      <div class="errs" id="ferr"></div><div style="margin-top:14px"><button class="btn" id="fsave">Save</button></div></div>`);
    $('#fsave').onclick = async () => { $('#fsave').disabled = true; try { await onSave(); } catch (e) { $('#ferr').textContent = e.message; $('#fsave').disabled = false; } };
  }
  const val = id => ($('#' + id) || {}).value;
  function fieldsManager() {
    const draw = () => {
      showModal(`<div class="mhead"><h2>Custom fields</h2><button class="btn sec close" id="mx">Close</button></div><div class="mbody">
        <div class="note">Add any per-well value your data doesn't carry yet (e.g. "Last H2S signage check", "Annulus B limit (psi)", "Near school"). It appears in the rule editor under <b>Custom</b> and on each well, where you can fill it in.</div>
        <h3>Fields</h3>${D.custom_fields.length ? `<table><thead><tr><th>Label</th><th>Type</th><th>Wells with a value</th><th></th></tr></thead><tbody>${D.custom_fields.map(c => `<tr><td><b>${esc(c.label)}</b><div class="muted small">${esc(c.help || '')}</div></td><td>${esc(c.field_type)}</td>
          <td>${D.snapshot.filter(w => w['x_' + c.field_key] !== null && w['x_' + c.field_key] !== undefined).length}</td><td style="white-space:nowrap"><a class="lk" data-fill="${c.field_key}">fill in for my wells</a> · <a class="lk" data-del="${c.field_key}" data-label="${esc(c.label)}">remove</a></td></tr>`).join('')}</tbody></table>` : '<div class="muted">None yet.</div>'}
        <h3>Add a field</h3><div class="frm"><div><label>Label</label><input id="cf-l" placeholder="e.g. Annulus B pressure limit (psi)"></div>
          <div><label>Type</label><select id="cf-t"><option value="number">Number</option><option value="text">Text</option><option value="yesno">Yes / no</option><option value="date">Date</option></select></div>
          <div class="full"><label>Help text</label><input id="cf-h" placeholder="What it means and where it comes from"></div></div>
        <div class="errs" id="ferr"></div><button class="btn" id="cf-add" style="margin-top:10px">Add field</button></div>`);
      $('#cf-add').onclick = async () => { try { await post('api/custom_fields', {label: val('cf-l'), field_type: val('cf-t'), help: val('cf-h')}); await refresh('Field added'); draw(); } catch (e) { $('#ferr').textContent = e.message; } };
      document.querySelectorAll('[data-del]').forEach(a => a.onclick = async () => { await post('api/custom_fields', {field_key: a.dataset.del, label: a.dataset.label, field_type: 'deleted'}); await refresh('Field removed'); draw(); });
      document.querySelectorAll('[data-fill]').forEach(a => a.onclick = () => fillField(a.dataset.fill));
    };
    draw();
  }
  function fillField(key) {
    const c = D.custom_fields.find(x => x.field_key === key), wells = myWells();
    const input = (w) => { const v = (D.attrs[w.well_id] || {})[key] ?? '';
      return c.field_type === 'yesno' ? `<select data-w="${w.well_id}"><option value="" ${v === '' ? 'selected' : ''}>Not set</option><option value="true" ${v === 'true' ? 'selected' : ''}>Yes</option><option value="false" ${v === 'false' ? 'selected' : ''}>No</option></select>`
        : `<input data-w="${w.well_id}" ${c.field_type === 'date' ? 'type="date"' : ''} value="${esc(v)}">`; };
    formModal(`${c.label}: values for ${engName()}'s wells`, `<div class="tw" style="max-height:60vh"><table><tbody>${wells.map(w => `<tr><td>${w.well_id} <span class="muted small">${esc(w.well_name)}</span></td><td>${input(w)}</td></tr>`).join('')}</tbody></table></div>`, async () => {
      const changed = [...document.querySelectorAll('#mbox [data-w]')].filter(el => el.value !== ((D.attrs[el.dataset.w] || {})[key] ?? ''));
      if (c.field_type === 'number') { const bad = changed.find(el => el.value !== '' && isNaN(Number(el.value))); if (bad) throw new Error(`${bad.dataset.w}: "${bad.value}" is not a number`); }
      for (const el of changed) await post('api/attributes/' + el.dataset.w, {values: {[key]: el.value}}, 'PUT');
      $('#modal').hidden = true; await refresh(`${changed.length} value(s) saved`);
    });
  }

  // ---------------- Well detail ----------------
  async function openWell(id) {
    DRAWER_WELL = id;
    const w = D.snapshot.find(x => x.well_id === id); const r = RANK.find(x => x.well_id === id);
    $('#dhead').innerHTML = `<div><h2>${id} · ${esc(w.well_name)}</h2><div class="muted small">${esc(w.engineer_name)} · ${esc(w.reservoir)} · ${esc(w.lift_type)} · ${esc(w.area)} · pad ${esc(w.pad)} · ${esc(w.sour_class)}</div></div>
      <button class="btn sec small" id="dask" style="margin-left:auto">Ask about this well</button><button class="btn sec close" id="dx">Close</button>`;
    $('#dx').onclick = () => { $('#drawer').hidden = true; DRAWER_WELL = null; }; $('#dask').onclick = () => ask(`Give me a summary of ${id}: how is it performing, is anything wrong, and are there any safety issues?`);
    $('#dbody').innerHTML = `<div class="empty dots">Loading ${id}</div>`; $('#drawer').hidden = false;
    let d; try { d = await api('api/well/' + id); } catch (e) { $('#dbody').innerHTML = `<div class="empty">Could not load: ${esc(e.message)}</div>`; return; }
    const {kp, sk, fx, alertF, boxAlert, boxHtml, thr} = wellModel(id, w, r);
    const sd = d.safety_daily, prod = d.daily.map(x => ({date: x.prod_date, y: x.reported ? x.oil_bbl : null, y2: x.target_oil_bopd}));
    const myTests = ITEMS.test.filter(t => t.well_id === id).sort((a, b) => (testState(a) - testState(b)) || (a.days_until_due - b.days_until_due));
    const myNotes = D.notes.filter(n => n.well_id === id);
    const myEvents = ITEMS.event.filter(e => e.well_id === id).sort((a, b) => String(b.event_date).localeCompare(String(a.event_date)));
    const charts = (list) => list.map(([fields, html]) => [fields.some(f => alertF.has(f)), html]).sort((a, b) => b[0] - a[0]).map(x => x[1]).join('');
    $('#dbody').innerHTML = `
      ${whyBox(r, fx, d, id, sk.filter(([l]) => !boxAlert(l)).map(([l]) => l))}
      <h3>Notes (${myNotes.length}) <a class="lk" id="dnote" style="text-transform:none;letter-spacing:0;margin-left:6px">+ add note</a></h3>
      ${myNotes.length ? myNotes.map(n => noteHtml(n, true)).join('') : '<div class="muted small">No notes. Add context the systems don\'t have: what the field told you, what is booked, what you are waiting for.</div>'}
      <h3>Flags today ${r ? (r.tier === 'handled' ? '· all being handled' : `· ${r.tier} · rank #${ACTIVE().indexOf(r) + 1} · ${r.score} pts${r.tier === 'production' ? ` · $${fmt(r.value)}/day` : ''}`) : ''}</h3>
      ${r ? `<div style="display:grid;grid-template-columns:44px 1fr auto">${r.flags.map(flagHtml).join('')}</div>` : '<div class="muted">No flags from your rules.</div>'}
      <h3>Safety <a class="lk small" ${lin({kind: 'safety_snapshot', well_id: id})} style="text-transform:none;letter-spacing:0;margin-left:6px">Trace these numbers</a></h3>
      <div class="kpis" style="grid-template-columns:repeat(4,1fr)">${sk.map(([l, v]) => boxHtml(l, v, 14)).join('')}</div>
      <div class="charts">
        ${charts([
          [['casing_pct_of_maasp', 'casing_psi_max_7d', 'casing_psi_change'], chartBox('Production casing vs MAASP (psi)', 'csgm', sd.map(x => ({date: x.reading_date, y: x.casing_psi, y2: x.prod_casing_maasp_psi})), {l1: 'Casing', l2: 'MAASP', kind: 'safety_daily', alert: ['casing_pct_of_maasp', 'casing_psi_max_7d', 'casing_psi_change'].some(f => alertF.has(f)), thresh: thr('casing_pct_of_maasp', pct => w.prod_casing_maasp_psi * pct / 100)})],
          [['sc_psi_max_7d', 'sc_psi_change', 'sc_pct_of_limit', 'scvf_status'], chartBox('Surface casing vs limit (psi)', 'scp', sd.map(x => ({date: x.reading_date, y: x.sc_psi, y2: x.surface_casing_limit_psi})), {l1: 'Surface casing', l2: 'Limit', kind: 'safety_daily', alert: ['sc_psi_max_7d', 'sc_psi_change', 'sc_pct_of_limit'].some(f => alertF.has(f)), thresh: thr('sc_pct_of_limit', pct => w.surface_casing_limit_psi * pct / 100)})],
          [['flowline_pct_of_maop', 'flowline_psi_max_7d'], chartBox('Flowline max vs MAOP (psi)', 'flp', sd.map(x => ({date: x.reading_date, y: x.flowline_psi_max, y2: x.flowline_maop_psi})), {l1: 'Flowline', l2: 'MAOP', kind: 'safety_daily', alert: alertF.has('flowline_pct_of_maop'), thresh: thr('flowline_pct_of_maop', pct => w.flowline_maop_psi * pct / 100)})],
          [['h2s_ambient_max_7d_ppm'], chartBox('H2S at surface, daily max (ppm)', 'h2s', sd.map(x => ({date: x.reading_date, y: x.h2s_ambient_ppm_max})), {kind: 'safety_daily', alert: alertF.has('h2s_ambient_max_7d_ppm'), thresh: thr('h2s_ambient_max_7d_ppm')})]])}
      </div>
      <h3>Tests and inspections (${myTests.length}) <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· from the maintenance / integrity system</span></h3>
      ${myTests.length ? TEST_LEGEND + `<div class="tw" style="max-height:280px"><table><thead><tr><th>Status</th><th>Test</th><th>Last done</th><th>Result</th><th>Next due</th><th>Source</th><th></th></tr></thead><tbody>
        ${myTests.map(t => `<tr><td>${testStatus(t)}</td><td>${esc(t.test_type)} ${t.safety_critical ? SC_LABEL : ''}</td><td>${esc(String(t.last_test_date).slice(0, 10))}</td>
          <td>${esc(t.last_result)}${t.result_value !== null && t.result_value !== undefined ? ` · ${esc(t.result_value)} ${esc(t.result_unit || '')}` : ''}</td>
          <td>${esc(String(t.next_due_date).slice(0, 10))}</td>
          <td class="muted small">${esc(t.source)}</td><td><a class="lk" ${lin(itemLin(t))}>trace</a></td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">None.</div>'}
      <h3>Safety events (${myEvents.length}) <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· from the HSE incident system</span></h3>
      ${myEvents.length ? `<div class="tw" style="max-height:240px"><table><thead><tr><th>Date</th><th>Category (AI)</th><th>As typed</th><th>Status</th><th>Regulator</th><th></th></tr></thead><tbody>
        ${myEvents.map(e => `<tr><td>${esc(String(e.event_date).slice(0, 10))}</td><td>${esc(e.category)}${e.planned ? ' <span class="muted small">(planned)</span>' : ''}</td><td class="muted">${esc(e.event_type_original)}: ${esc(e.description || '')}</td>
          <td>${e.status === 'Closed' ? 'Closed' : `<span class="pill crit">${ic('x')} Open</span>`}</td><td>${e.reportable ? (e.reported_to_regulator ? 'Reported' : `<span class="pill crit">${ic('x')} Not reported</span>`) : ''}</td>
          <td style="white-space:nowrap"><a class="lk" ${lin(itemLin(e))}>trace</a></td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">None.</div>'}
      ${D.custom_fields.length ? `<h3>Custom fields <a class="lk" id="dcf" style="text-transform:none;letter-spacing:0;margin-left:6px">edit</a></h3><div class="kpis" style="grid-template-columns:repeat(4,1fr)">
        ${D.custom_fields.map(c => `<div class="kpi"><div class="n" style="font-size:14px">${esc(F.fmtVal('x_' + c.field_key, w['x_' + c.field_key]))}</div><div class="l">${esc(c.label)}</div></div>`).join('')}</div>` : ''}
      <h3>Production snapshot as of ${D.as_of} <a class="lk small" ${lin({kind: 'snapshot', well_id: id})} style="text-transform:none;letter-spacing:0;margin-left:6px">Trace these numbers</a></h3>
      <div class="kpis" style="grid-template-columns:repeat(4,1fr)">${kp.map(([l, v]) => boxHtml(l, v, 16)).join('')}</div>
      <h3>Daily data since Aug 1 <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· click any point to trace it back to the raw file</span></h3>
      <div class="charts">
        ${charts([
          [['perf_ratio_7d', 'consecutive_down_days'], chartBox('Oil (bbl/d) vs type curve', 'oil', prod, {l1: 'Oil', l2: 'Type curve', alert: ['perf_ratio_7d', 'consecutive_down_days'].some(f => alertF.has(f))})],
          [['water_cut_change_pts'], chartBox('Water cut (%)', 'wc', d.daily.map(x => ({date: x.prod_date, y: x.water_cut === null ? null : 100 * x.water_cut})), {alert: alertF.has('water_cut_change_pts')})],
          [['gor_change_pct'], chartBox('Gas-oil ratio (scf/bbl)', 'gor', d.daily.map(x => ({date: x.prod_date, y: x.gor_scf_bbl})), {alert: alertF.has('gor_change_pct')})],
          [['casing_psi_change'], chartBox('Production casing pressure (psi)', 'csg', d.daily.map(x => ({date: x.prod_date, y: x.casing_psi})), {alert: alertF.has('casing_psi_change')})]])}
      </div>
      <h3>Downtime events (${d.downtime.length})</h3>
      ${d.downtime.length ? `<div class="tw" style="max-height:260px"><table><thead><tr><th>Date</th><th>Category (AI)</th><th>Operator's text</th><th class="n">Hours</th><th>Planned</th><th></th></tr></thead><tbody>
        ${d.downtime.map(e => `<tr><td>${esc(e.event_date)}</td><td>${esc(e.category)}</td><td class="muted">${esc(e.reason_original)}</td><td class="n">${e.is_open ? '<span class="pill crit">open</span>' : fmt(e.hours_lost, 1)}</td><td>${e.planned ? 'yes' : 'no'}</td>
          <td><a class="lk" ${lin({kind: 'downtime', bronze_id: e._bronze_id})}>trace</a></td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">None.</div>'}
      <h3>Monthly economics</h3>
      <div class="tw"><table><thead><tr><th>Month</th><th class="n">Oil bbl</th><th class="n">BOE</th><th class="n">Netback $</th><th class="n">Operating cost $</th><th class="n">Margin $</th><th class="n">Margin $/boe</th><th></th></tr></thead><tbody>
        ${d.economics.map(e => `<tr><td>${esc(String(e.month).slice(0, 7))}</td><td class="n">${fmt(e.oil_bbl)}</td><td class="n">${fmt(e.boe)}</td><td class="n">${fmt(e.netback_cad)}</td><td class="n">${fmt(e.loe_cad)}</td>
          <td class="n">${fmt(e.operating_margin_cad)}</td><td class="n">${fmt(e.netback_per_boe - e.loe_per_boe, 2)}</td><td><a class="lk" ${lin({kind: 'economics', well_id: id, month: String(e.month).slice(0, 10)})}>trace</a></td></tr>`).join('')}</tbody></table></div>
      <h3>Work orders (${d.work_orders.length})</h3>
      ${d.work_orders.length ? `<div class="tw"><table><thead><tr><th>WO</th><th>Type</th><th>Description</th><th>Start</th><th>End</th><th>Status</th><th></th></tr></thead><tbody>
        ${d.work_orders.map(o => `<tr><td>${esc(o.wo_number)}</td><td>${esc(o.wo_type)}</td><td>${esc(o.description)}</td><td>${esc(o.start_date)}</td><td>${esc(o.end_date || '')}</td><td>${esc(o.status)}</td>
          <td><a class="lk" ${lin({kind: 'work_order', bronze_id: o._bronze_id})}>trace</a></td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">None.</div>'}`;
    bindCommon($('#dbody')); bindFlagActions($('#dbody'));
    $('#dnote').onclick = () => noteForm({well_id: id});
    document.querySelectorAll('#dbody [data-arch]').forEach(a => a.onclick = async () => { await post(`api/notes/${a.dataset.arch}/archive`, {}); await refresh('Note archived'); openWell(id); });
    if ($('#dcf')) $('#dcf').onclick = () => editWellFields(id);
    bindCharts(id);
  }
  // Numbers, alert fields and rule thresholds for one well: shared by the well page and the well report.
  function wellModel(id, w, r) {
    const kp = [['Oil, last 7 d', fmt(w.oil_7d_bopd, 1) + ' bbl/d'], ['vs type curve', fmt(w.perf_ratio_7d, 2) + '×'], ['Water cut', fmt(w.water_cut_7d_pct, 1) + '% (' + (w.water_cut_change_pts > 0 ? '+' : '') + fmt(w.water_cut_change_pts, 1) + ' pts)'],
      ['GOR', fmt(w.gor_7d) + ' (' + (w.gor_change_pct > 0 ? '+' : '') + fmt(w.gor_change_pct, 1) + '%)'], ['Casing', fmt(w.casing_psi_7d) + ' psi (' + (w.casing_psi_change > 0 ? '+' : '') + fmt(w.casing_psi_change) + ')'],
      ['Uptime 14 d', fmt(w.uptime_14d_pct, 1) + '%'], ['Margin (Oct)', '$' + fmt(w.margin_per_boe, 2) + '/boe'], ['At risk', '$' + fmt(w.value_at_risk_cad_day) + '/day']];
    const fx = buildFocus(id);
    const alertF = new Set(fx ? Object.keys(fx.cols) : []);
    if (r) for (const f of r.flags.filter(f => !f.handled)) {
      if (f.dataset === 'test') alertF.add('tests_overdue');
      const rule = RULES.find(x => x.id === f.rule_id);
      if (f.dataset === 'event' && rule && rule.conditions.some(c => /h2s/i.test(String(c.value)))) alertF.add('h2s_ambient_max_7d_ppm');
    }
    const BOXF = {'Casing vs MAASP': ['casing_pct_of_maasp', 'casing_psi_max_7d', 'casing_psi_change'], 'Surface casing': ['sc_psi_max_7d', 'sc_psi_change', 'sc_pct_of_limit'],
      'Flowline vs MAOP': ['flowline_pct_of_maop', 'flowline_psi_max_7d'], 'Vent flow test': ['scvf_status'], 'H2S': ['h2s_ambient_max_7d_ppm', 'h2s_ppm_gas'], 'EPZ': ['residences_in_epz'],
      'Venting this month': ['vent_pct_of_limit', 'vent_mtd_m3'], 'Tests': ['tests_overdue', 'critical_tests_overdue', 'failed_tests'],
      'Oil, last 7 d': ['perf_ratio_7d', 'oil_7d_bopd'], 'vs type curve': ['perf_ratio_7d'], 'Water cut': ['water_cut_change_pts', 'water_cut_7d_pct'], 'GOR': ['gor_change_pct', 'gor_7d'],
      'Casing': ['casing_psi_change', 'casing_psi_7d'], 'Uptime 14 d': ['consecutive_down_days', 'downtime_events_14d', 'uptime_14d_pct'], 'Margin (Oct)': ['margin_per_boe'], 'At risk': ['value_at_risk_cad_day', 'perf_ratio_7d', 'consecutive_down_days']};
    const boxAlert = l => (BOXF[l] || []).some(f => alertF.has(f));
    const boxHtml = (l, v, size) => `<div class="kpi ${boxAlert(l) ? 'kpi-alert' : ''}"><div class="n" style="font-size:${size}px">${esc(v)}</div><div class="l">${l}${boxAlert(l) ? ` <b class="flagtxt">${ic('flag')} why it's flagged</b>` : ''}</div></div>`;
    const sk = [['Casing vs MAASP', `${fmt(w.casing_psi_max_7d)} / ${fmt(w.prod_casing_maasp_psi)} psi (${fmt(w.casing_pct_of_maasp, 0)}%)`], ['Surface casing', `${fmt(w.sc_psi_max_7d, 0)} / ${fmt(w.surface_casing_limit_psi)} psi (${fmt(w.sc_pct_of_limit, 0)}%)`],
      ['Flowline vs MAOP', `${fmt(w.flowline_psi_max_7d, 0)} / ${fmt(w.flowline_maop_psi)} psi (${fmt(w.flowline_pct_of_maop, 0)}%)`], ['Vent flow test', `${w.scvf_status || 'None'}${w.scvf_rate_m3d ? ' · ' + fmt(w.scvf_rate_m3d) + ' m3/d' : ''}`],
      ['H2S', `${fmt(w.h2s_ppm_gas)} ppm in gas · ${fmt(w.h2s_ambient_max_7d_ppm)} ppm at surface`], ['EPZ', w.epz_m ? `${fmt(w.epz_m)} m · ${fmt(w.residences_in_epz)} residence${Number(w.residences_in_epz) === 1 ? '' : 's'}` : 'none (sweet)'],
      ['Venting this month', `${fmt(w.vent_mtd_m3)} / ${fmt(w.vent_limit_m3_month)} m3 (${fmt(w.vent_pct_of_limit, 0)}%)`], ['Tests', `${fmt(w.tests_overdue)} overdue · ${fmt(w.tests_due_30d)} due ≤30 d · ${fmt(w.failed_tests)} failed`]];
    // rule threshold drawn on each safety chart (red when it's why the well is flagged)
    const thr = (field, toUnits) => { const rl = RULES.find(x => x.enabled && (x.dataset || 'well') === 'well' && x.conditions.some(c => c.field === field && ['gt', 'gte'].includes(c.op)));
      if (!rl) return null; const c = rl.conditions.find(c => c.field === field && ['gt', 'gte'].includes(c.op)); const v = toUnits ? toUnits(Number(c.value)) : Number(c.value);
      return isFinite(v) ? {v, label: `${rl.name}: flag at ${c.op === 'gte' ? '≥' : '>'} ${fmt(c.value, 0)}${toUnits ? '%' : ''}`, on: alertF.has(field)} : null; };
    return {kp, sk, fx, alertF, boxAlert, boxHtml, thr};
  }
  // Plain statement of what makes this well flagged: measured value vs the rule's threshold, and on which days.
  function whyBox(r, fx, d, id, okBoxes) {
    if (!r) return `<div class="whybox ok"><b>Nothing is flagged on this well</b> under your current rules.</div>`;
    const open = r.flags.filter(f => !f.handled);
    if (!open.length) return `<div class="whybox ok"><b>Every flag on this well is marked as being handled.</b> See below.</div>`;
    const recent = rows => rows.filter(x => String(x.reading_date || x.prod_date) >= '2026-11-09');
    const sd = recent(d.safety_daily), dd = recent(d.daily);
    const opTxt = {gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', ne: '≠', is_true: 'is yes', is_false: 'is no', one_of: 'is one of', contains: 'contains'};
    const items = open.map(f => {
      const rule = RULES.find(x => x.id === f.rule_id); let detail = '';
      if (!f.items && rule) {
        detail = rule.conditions.map((cn, i) => {
          if (f.evidence[i] && !f.evidence[i].matched) return '';
          const fd = F.fieldOf('well', cn.field); const v = r.fact[cn.field];
          // which recent days crossed it, from the daily data shown on this page
          let days = [];
          for (const [col, tst] of RELATED[cn.field] || []) {
            const test = tst === 'same' ? (val => F.matchValue(cn, val, 'well', D.today)) : tst;
            if (!test) continue;
            for (const row of sd.concat(dd)) if (col in row && hitCell({tests: [test]}, row[col])) days.push(String(row.reading_date || row.prod_date).slice(5, 10));
          }
          days = [...new Set(days)].sort();
          return `<li><b>${esc(fd ? fd.label : cn.field)}: ${esc(F.fmtVal(cn.field, v))}</b> <span class="muted">· ${['is_true', 'is_false'].includes(cn.op) ? `flags when ${cn.op === 'is_true' ? 'yes' : 'no'}` : `flags at ${esc(opTxt[cn.op] || cn.op)} ${esc(cn.value ?? '')}`}</span>${days.length ? ` <span class="muted">· crossed on ${days.length} of the last 14 days (${esc(days.join(', '))})</span>` : ''}</li>`;
        }).join('');
      } else if (f.items) {
        detail = f.items.slice(0, 5).map(it => `<li><a class="lk" ${lin(itemLin(it))}>${esc(F.DATASETS[f.dataset].describe(it))}</a></li>`).join('') + (f.items.length > 5 ? `<li class="muted">+${f.items.length - 5} more</li>` : '');
      }
      return `<div style="margin-top:6px"><span class="sev ${f.severity}" style="display:inline-block;margin-right:6px">${f.severity}</span>${f.safety ? SAFETY_TAG : ''}<b>${esc(f.rule_name)}</b><ul style="margin:3px 0 0 18px;padding:0">${detail}</ul></div>`;
    }).join('');
    return `<div class="whybox"><div style="display:flex;align-items:center;gap:8px"><b style="font-size:15px">Why this well is flagged</b>
        <a class="lk small" ${lin({kind: r.flags.some(f => f.safety && !f.handled) ? 'safety_snapshot' : 'snapshot', well_id: id})}>Show the readings behind this</a></div>${items}
      ${okBoxes.length ? `<div class="note" style="margin-top:8px">Not part of the problem: ${esc(okBoxes.join(', '))} ${okBoxes.length > 1 ? 'are' : 'is'} within limits.</div>` : ''}
      <div class="note" style="margin-top:6px">Boxes and charts marked "why it's flagged" below are the ones behind these flags.</div></div>`;
  }
  function editWellFields(id) {
    formModal(`Custom fields for ${id}`, `<div class="frm">${D.custom_fields.map(c => { const v = (D.attrs[id] || {})[c.field_key] ?? '';
      return `<div><label>${esc(c.label)}</label>${c.field_type === 'yesno' ? `<select data-k="${c.field_key}"><option value="">Not set</option><option value="true" ${v === 'true' ? 'selected' : ''}>Yes</option><option value="false" ${v === 'false' ? 'selected' : ''}>No</option></select>`
        : `<input data-k="${c.field_key}" ${c.field_type === 'date' ? 'type="date"' : ''} value="${esc(v)}">`}<div class="note">${esc(c.help || '')}</div></div>`; }).join('')}</div>`, async () => {
      const values = {}; document.querySelectorAll('#mbox [data-k]').forEach(el => { if (el.value !== ((D.attrs[id] || {})[el.dataset.k] ?? '')) values[el.dataset.k] = el.value; });
      for (const [k, v] of Object.entries(values)) { const c = D.custom_fields.find(x => x.field_key === k); if (c.field_type === 'number' && v !== '' && isNaN(Number(v))) throw new Error(`${c.label}: not a number`); }
      if (Object.keys(values).length) await post('api/attributes/' + id, {values}, 'PUT');
      $('#modal').hidden = true; await refresh('Saved'); openWell(id);
    });
  }

  // Small SVG line chart. Points carry their date so a click can open lineage for that well-day.
  const CH = {};
  function chartBox(title, key, pts, o = {}) {
    CH[key] = {pts, kind: o.kind || 'daily'};
    const W = 420, H = 150, L = 40, R = 8, T = 8, B = 20;
    const ys = pts.flatMap(p => [p.y, p.y2]).concat(o.thresh ? [o.thresh.v] : []).filter(v => v !== null && v !== undefined && isFinite(v));
    if (!ys.length) return `<div class="chart"><div class="ct">${title}</div><div class="muted small">No data.</div></div>`;
    let lo = Math.min(...ys), hi = Math.max(...ys); if (lo === hi) { lo -= 1; hi += 1; } const pad = (hi - lo) * 0.08; lo = Math.max(lo - pad, Math.min(...ys) >= 0 ? 0 : lo - pad); hi += pad;
    const x = i => L + (W - L - R) * i / Math.max(1, pts.length - 1), y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const path = k => { let s = '', pen = false; pts.forEach((p, i) => { const v = p[k]; if (v === null || v === undefined) { pen = false; return; } s += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); pen = true; }); return s; };
    const ticks = [lo, (lo + hi) / 2, hi].map(v => `<text x="${L - 4}" y="${y(v) + 3}" text-anchor="end" font-size="9" >${fmt(v, hi - lo < 5 ? 1 : 0)}</text><line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" style="stroke:var(--dk-ghost-border)"/>`).join('');
    const months = pts.map((p, i) => [String(p.date), i]).filter(([d]) => d.slice(8, 10) === '01').map(([d, i]) => `<text x="${x(i)}" y="${H - 6}" font-size="9" text-anchor="middle">${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+d.slice(5, 7) - 1]}</text>`).join('');
    const limit = o.l2 && ['MAASP', 'Limit', 'MAOP'].includes(o.l2);
    const t = o.thresh, tc = t && t.on ? 'var(--dk-viz-bad)' : 'var(--dk-viz-neutral)';
    const tLine = t ? `<line x1="${L}" x2="${W - R}" y1="${y(t.v)}" y2="${y(t.v)}" style="stroke:${tc}" stroke-width="1.2" stroke-dasharray="2 2"/><text x="${W - R - 2}" y="${y(t.v) - 3}" text-anchor="end" font-size="9" style="fill:${tc}">${esc(t.label)}</text>` : '';
    const dots = t && t.on ? pts.map((p, i) => p.y !== null && p.y !== undefined && p.y >= t.v ? `<circle cx="${x(i).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="2.6" style="fill:var(--dk-viz-bad)"/>` : '').join('') : '';
    return `<div class="chart ${o.alert ? 'chart-alert' : ''}"><div class="ct">${title}${o.alert ? ` <b class="flagtxt">${ic('flag')} why it's flagged</b>` : ''}</div>${o.l1 ? `<div class="lg"><svg width="16" height="8" aria-hidden="true"><line x1="0" y1="4" x2="16" y2="4" style="stroke:var(--dk-viz-brand)" stroke-width="2"/></svg> ${o.l1} &nbsp; <svg width="16" height="8" aria-hidden="true"><line x1="0" y1="4" x2="16" y2="4" style="stroke:${limit ? 'var(--dk-viz-bad)' : 'var(--dk-viz-compare)'}" stroke-width="1.5" stroke-dasharray="4 3"/></svg> ${o.l2}</div>` : ''}
      <svg viewBox="0 0 ${W} ${H}" data-chart="${key}" data-l="${L}" data-r="${R}" data-w="${W}">${ticks}${months}
        ${pts.some(p => p.y2 !== undefined) ? `<path d="${path('y2')}" fill="none" style="stroke:${limit ? 'var(--dk-viz-bad)' : 'var(--dk-viz-compare)'}" stroke-width="1.5" stroke-dasharray="4 3"/>` : ''}
        ${tLine}<path d="${path('y')}" fill="none" style="stroke:var(--dk-viz-brand)" stroke-width="1.8"/>${dots}
        <line class="hair" x1="0" x2="0" y1="${T}" y2="${H - B}" style="stroke:var(--dk-outline)" visibility="hidden"/>
        <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" style="cursor:pointer"/></svg></div>`;
  }
  function bindCharts(id) {
    document.querySelectorAll('svg[data-chart]').forEach(svg => {
      const {pts, kind} = CH[svg.dataset.chart], L = +svg.dataset.l, R = +svg.dataset.r, W = +svg.dataset.w;
      const idx = e => { const b = svg.getBoundingClientRect(); const sx = (e.clientX - b.left) * W / b.width; return Math.max(0, Math.min(pts.length - 1, Math.round((sx - L) / (W - L - R) * (pts.length - 1)))); };
      svg.onmousemove = e => { const i = idx(e), p = pts[i], tip = $('#tip'), hair = svg.querySelector('.hair'); const xx = L + (W - L - R) * i / Math.max(1, pts.length - 1);
        hair.setAttribute('x1', xx); hair.setAttribute('x2', xx); hair.setAttribute('visibility', 'visible');
        tip.innerHTML = `${String(p.date).slice(0, 10)}: <b>${p.y === null || p.y === undefined ? 'no data' : fmt(p.y, 1)}</b>${p.y2 !== undefined ? ` · ${fmt(p.y2, 1)}` : ''}<br><span style="opacity:.75">click to trace to raw file</span>`;
        tip.hidden = false; tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px'; };
      svg.onmouseleave = () => { $('#tip').hidden = true; svg.querySelector('.hair').setAttribute('visibility', 'hidden'); };
      svg.onclick = e => lineage({kind, well_id: id, date: String(pts[idx(e)].date).slice(0, 10)});
    });
  }

  // ---------------- Lineage ----------------
  async function lineage(p) {
    showModal(`<div class="mhead"><h2>Where this number comes from</h2><button class="btn sec close" id="mx">Close</button></div><div class="mbody"><div class="empty dots">Tracing</div></div>`);
    const q = Object.assign({}, p); delete q.focus_well;
    let d; try { d = await api('api/lineage?' + new URLSearchParams(q)); } catch (e) { $('#mbox .mbody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const fx = buildFocus(p.well_id || p.focus_well || DRAWER_WELL, ['test', 'safety_event'].includes(p.kind) ? p.bronze_id : null);
    const sub = {daily: `${p.well_id} on ${p.date}`, safety_daily: `${p.well_id} safety readings on ${p.date}`, snapshot: `${p.well_id} production snapshot`, safety_snapshot: `${p.well_id} safety snapshot`,
      economics: `${p.well_id} ${String(p.month).slice(0, 7)}`, test: `test record ${p.bronze_id}`, safety_event: `safety event ${p.bronze_id}`}[p.kind] || p.kind.replace('_', ' ');
    $('#mbox .mbody').innerHTML = focusBanner(fx) + `<div class="note" style="margin:4px 0 12px">${esc(sub)} · gold (what the app and the assistant read), then silver (cleaned), then bronze (as received), then the raw file</div>` +
      d.steps.map(s => `<div class="step"><div><span class="layer ${s.layer}">${s.layer}</span> ${tableUrl(s.table) ? `<a class="small" href="${esc(tableUrl(s.table))}" target="_blank" rel="noopener"><code>${esc(s.table)}</code> ${ic('ext')}</a>` : s.layer === 'raw' ? `<a class="small" href="${esc(D.workspace_url + '/explore/data/volumes/' + SCH().replace('.', '/') + '/landing')}" target="_blank" rel="noopener"><code>${esc(LANDING())}</code> ${ic('ext')}</a>` : `<code class="small">${esc(s.table)}</code>`}</div>
        ${s.note ? `<div class="note" style="margin:3px 0">${esc(s.note)}</div>` : ''}
        ${(s.rules || []).length ? `<div class="rulebox"><b>Cleaning rules applied:</b>${[...new Map(s.rules.map(r => [r.rule_id, r])).values()].map(r => `<div><code>${esc(r.rule_id)}</code> ${esc(r.description)}</div>`).join('')}</div>` : ''}
        ${s.files ? `<div class="rulebox">${s.files.map(f => `${ic('file', 'md')} ${esc(f)}`).join('<br>')}</div>` : ''}
        ${s.rows ? rowsTable(s.rows, {focus: fx, traceFn: s.trace_daily ? r => ({kind: 'daily', well_id: p.well_id, date: String(r.prod_date).slice(0, 10)}) : s.trace_safety ? r => ({kind: 'safety_daily', well_id: p.well_id, date: String(r.reading_date).slice(0, 10)}) : null}) : ''}</div>`).join('');
    document.querySelectorAll('#mbox [data-lin]').forEach(a => a.onclick = () => lineage(JSON.parse(a.dataset.lin)));
  }
  function rowsTable(rows, o = {}) {
    if (!rows.length) return '<div class="muted small">No rows.</div>';
    const fx = o.focus, fc = c => fx && fx.cols[c.toLowerCase()];
    let cols = Object.keys(rows[0]).filter(c => !['_rescued_data'].includes(c));
    const cell = v => v === null || v === undefined ? '<span class="muted">null</span>' : typeof v === 'object' ? esc(JSON.stringify(v)) : esc(v);
    const cls = (c, v) => hitCell(fc(c), v) ? 'fhit' : fc(c) ? 'fcol' : '';
    const isItem = r => fx && [r.record_id, r.test_id, r.event_id, r.entry_id].some(x => x && fx.itemIds.has(x));
    if (rows.length === 1 && cols.length > 8 && !o.traceFn) {
      const r0 = rows[0];
      if (fx) cols = cols.slice().sort((a, b) => (hitCell(fc(b), r0[b]) - hitCell(fc(a), r0[a])) || (!!fc(b) - !!fc(a)));
      return `<div class="tw" style="max-height:300px"><table><tbody>${cols.map(c => `<tr><th style="position:static" class="${fc(c) ? 'fcol' : ''}">${esc(c)}</th><td class="${cls(c, r0[c])}">${cell(r0[c])}${hitCell(fc(c), r0[c]) ? ' ' + ic('flag') : ''}</td></tr>`).join('')}</tbody></table></div>`;
    }
    if (fx) {  // flagged columns move next to the identifying columns so they're visible without scrolling
      const key = c => /^(well_id|uwi_alias|prod_date|reading_date|event_date|event_ts|test_date|month|test_id|event_id|record_id|entry_id|test_type|category)$/i.test(c);
      cols = cols.filter(key).concat(cols.filter(c => !key(c) && fc(c)), cols.filter(c => !key(c) && !fc(c)));
    }
    const shown = rows.slice(0, 120);
    const rowHit = r => isItem(r) || cols.some(c => hitCell(fc(c), r[c]));
    const nHit = fx ? shown.filter(rowHit).length : 0;
    return `${nHit ? `<div class="small" style="color:var(--dk-status-bad);margin:6px 0">${ic('flag')} ${nHit} of ${shown.length} row${shown.length === 1 ? '' : 's'} crossed a flag threshold or belong to the flag (marked below).</div>` : ''}
      <div class="tw"><table><thead><tr>${o.traceFn ? '<th></th>' : ''}${cols.map(c => `<th class="${fc(c) ? 'fcol' : ''}">${esc(c)}</th>`).join('')}</tr></thead><tbody>
      ${shown.map(r => { const t = o.traceFn ? o.traceFn(r) : null, h = fx && rowHit(r);
        return `<tr class="${r._used_in_silver ? 'used' : ''} ${h ? 'frow' : ''}">${o.traceFn ? `<td>${h ? ic('flag') + ' ' : ''}${t ? `<a class="lk" ${lin(t)}>trace</a>` : ''}</td>` : ''}${cols.map(c => `<td class="${cls(c, r[c])}">${cell(r[c])}</td>`).join('')}</tr>`; }).join('')}</tbody></table></div>
      ${rows.length > 120 ? `<div class="muted small">first 120 of ${rows.length} rows</div>` : ''}`;
  }
  function showModal(html) { $('#mbox').innerHTML = html; $('#modal').hidden = false; $('#mx').onclick = () => $('#modal').hidden = true; }

  // ---------------- Rules ----------------
  function condText(cn, ds) {
    const f = F.fieldOf(ds, cn.field); const op = (F.OPS[f ? f.type : 'number'].find(o => o[0] === cn.op) || [cn.op, cn.op])[1];
    const v = F.NEEDS_FIELD.has(cn.op) ? (F.fieldOf(ds, cn.value) || {}).label : F.NEEDS_VALUE.has(cn.op) ? cn.value : '';
    return `<code>${esc(f ? f.label : cn.field + ' (missing field)')}</code> ${esc(op.replace(' field', '').replace(' (comma list)', ''))} ${v !== '' && v !== undefined ? `<code>${esc(v)}</code>` : ''}`;
  }
  function renderRules() {
    const counts = {}; RANK.forEach(r => r.flags.forEach(f => counts[f.rule_id] = (counts[f.rule_id] || 0) + 1));
    const cats = ['All', ...new Set(RULES.map(r => r.category || 'Other'))];
    const shown = RULES.map((r, i) => [r, i]).filter(([r]) => ruleFilter === 'All' || (r.category || 'Other') === ruleFilter);
    const missing = F.DEFAULT_RULES.filter(d => !RULES.some(r => r.id === d.id));
    $('#main').innerHTML = `<div class="bar"><button class="btn" id="newrule">+ New rule</button><button class="btn sec" id="lib">Rule library${missing.length ? ` (${missing.length} not in use)` : ''}</button><button class="btn sec" id="reset">Reset to defaults</button>
        <span style="margin-left:14px" class="note">Rank production problems by</span><div class="seg"><button data-m="value" class="${MODE === 'value' ? 'on' : ''}">$/day at risk</button><button data-m="payback" class="${MODE === 'payback' ? 'on' : ''}">Fastest payback</button><button data-m="score" class="${MODE === 'score' ? 'on' : ''}">Points</button></div></div>
      <div class="bar"><span class="note"><b>Safety first, always:</b> wells with a Critical or Warning safety flag are listed above every production problem. This can't be turned off.</span>
        <label class="note" style="display:flex;gap:6px;align-items:center;cursor:pointer;margin-left:14px"><input type="checkbox" id="woh" ${WO_HANDLED ? 'checked' : ''}> Treat wells with an open work order as being handled (production flags only)</label></div>
      <div class="note" style="margin-bottom:8px">These are ${esc(engName())}'s rules${rulesSource === 'saved' ? ` (saved ${esc(String(D.saved_rules[ENG]?.saved_at || 'this session').slice(0, 16))})` : ' (defaults; not yet saved)'}. Wells are listed in tiers: safety first, then production and cost problems by ${SORT_LABEL()}, then a watch list. The ${LOCKED.size} built-in safety rules are set by the operator and locked: always on, view and copy only. Every save is kept as a new version with who saved it. Points (the sum of rule weights, with rules in the same group counted once) break ties. Rules can look at well readings, at each test or inspection, or at each safety event. No AI decides a flag.</div>
      <div class="bar"><div class="filt">${cats.map(c => `<button data-cat="${esc(c)}" class="${ruleFilter === c ? 'on' : ''}">${esc(c)} ${c === 'All' ? RULES.length : RULES.filter(r => (r.category || 'Other') === c).length}</button>`).join('')}</div></div>
      <div class="card">${shown.map(([r, i]) => { const ds = r.dataset || 'well'; return `<div class="rule ${r.enabled ? '' : 'off'}">
        ${isLocked(r) ? `<button class="switch on locked" disabled aria-label="${esc(r.name)}: always on, locked" title="Built-in safety rule: always on"></button>` : `<button class="switch ${r.enabled ? 'on' : ''}" data-i="${i}" title="${r.enabled ? 'Turn off' : 'Turn on'}"></button>`}
        <div><div><span class="sev ${esc(r.severity)}" style="display:inline-block;margin-right:8px">${esc(r.severity)}</span>${F.isSafety(r) ? SAFETY_TAG : ''}${isLocked(r) ? '<span class="pill">Locked</span> ' : ''}<b>${esc(r.name)}</b> <span class="muted small">${esc(r.category || '')}</span><span class="ds">${esc(F.DATASETS[ds].label)}</span></div>
          <div class="cond" style="margin-top:4px">${ds === 'well' ? 'When' : `When at least <b>${r.min_count || 1}</b> ${ds === 'test' ? 'test(s)' : 'event(s)'} have`} ${r.match === 'any' ? '<b>any</b>' : '<b>all</b>'} of: ${r.conditions.map(cn => condText(cn, ds)).join(' · ')}</div>
          <div class="muted small" style="margin-top:2px">Flags ${counts[r.id] || 0} of your wells now${r.group ? ` · group: ${esc(r.group)} (counted once)` : ''}${r.fix_cost ? ` · typical fix ≈ $${fmt(r.fix_cost)}` : ''}</div></div>
        <div style="display:flex;gap:10px;align-items:start"><div class="wt">${r.weight}<small>points</small></div><button class="btn sec small" data-edit="${i}">${isLocked(r) ? 'View' : 'Edit'}</button><button class="btn sec small" data-dup="${i}">Copy</button></div></div>`; }).join('')}</div>`;
    document.querySelectorAll('.switch[data-i]').forEach(b => b.onclick = async () => { const r = RULES[+b.dataset.i]; if (isLocked(r)) return; r.enabled = !r.enabled; await persist(`${r.name} turned ${r.enabled ? 'on' : 'off'}`); });
    document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editRule(+b.dataset.edit));
    document.querySelectorAll('[data-dup]').forEach(b => b.onclick = () => { const cp = clone(RULES[+b.dataset.dup]); cp.id = 'CUSTOM_' + Date.now(); cp.name += ' (copy)'; editRule(null, cp); });
    document.querySelectorAll('[data-m]').forEach(b => b.onclick = async () => { MODE = b.dataset.m; await persist('Production problems ranked by ' + SORT_LABEL()); });
    $('#woh').onchange = async e => { WO_HANDLED = e.target.checked; await persist(WO_HANDLED ? 'Open work orders count as being handled' : 'Open work orders no longer hide flags'); };
    document.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { ruleFilter = b.dataset.cat; renderRules(); });
    $('#newrule').onclick = () => editRule(null);
    $('#lib').onclick = library;
    $('#reset').onclick = async () => { RULES = clone(F.DEFAULT_RULES); MODE = 'value'; SAFETY_FIRST = true; WO_HANDLED = false; await persist('Rules reset to defaults'); };
  }
  function library() {
    const draw = () => {
      showModal(`<div class="mhead"><h2>Rule library</h2><button class="btn sec close" id="mx">Close</button></div><div class="mbody">
        <div class="note">Starter rules. Add any you removed, or copy one as the starting point for your own.</div>
        <table><tbody>${F.DEFAULT_RULES.map(d => { const inUse = RULES.some(r => r.id === d.id); return `<tr><td>${F.isSafety(d) ? SAFETY_TAG : ''}<b>${esc(d.name)}</b><span class="ds">${esc(F.DATASETS[d.dataset || 'well'].label)}</span>
          <div class="muted small">${esc(d.severity)} · ${d.weight} pts · ${d.conditions.map(cn => condText(cn, d.dataset || 'well')).join(' · ')}</div></td>
          <td style="white-space:nowrap">${inUse ? '<span class="muted small">in use</span>' : `<button class="btn small" data-add="${d.id}">Add</button>`}</td></tr>`; }).join('')}</tbody></table></div>`);
      document.querySelectorAll('[data-add]').forEach(b => b.onclick = async () => { RULES.push(clone(F.DEFAULT_RULES.find(d => d.id === b.dataset.add))); await persist('Rule added'); draw(); });
    };
    draw();
  }
  async function persist(msg) {
    recompute(); render();
    try { const r = await post('api/rules/' + ENG, {rules: RULES, mode: MODE, safety_first: SAFETY_FIRST, wo_handled: WO_HANDLED}, 'PUT');
      D.saved_rules[ENG] = {rules: clone(RULES), mode: MODE, saved_by: r.saved_by, saved_at: new Date().toISOString().replace('T', ' ')}; D.settings[ENG] = {safety_first: true, wo_handled: WO_HANDLED}; rulesSource = 'saved';
      if ((r.restored_safety_rules || []).length) { RULES = restoreLocked(RULES); D.saved_rules[ENG].rules = clone(RULES); recompute(); toast('Saved. Built-in safety rules kept as shipped: ' + r.restored_safety_rules.join(', ')); } else toast(msg + ' · saved');
      render();
    } catch (e) { toast('Could not save: ' + e.message); }
  }
  function toast(t) { const el = document.createElement('div'); el.className = 'toast' + (/^Could not|failed/i.test(t) ? ' err' : ''); el.setAttribute('role', 'status'); el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 3500); }

  function editRule(i, preset) {
    const isNew = i === null, locked = !isNew && isLocked(RULES[i]);
    const r = preset || (isNew ? {id: 'CUSTOM_' + Date.now(), name: '', severity: 'Warning', weight: 20, category: 'Safety', enabled: true, match: 'all', dataset: 'well',
      conditions: [{field: 'casing_pct_of_maasp', op: 'gte', value: 70}], message: '', action: ''} : clone(RULES[i]));
    r.dataset = r.dataset || 'well';
    const fieldOpts = (ds, sel, onlyNum) => { const fs = F.DATASETS[ds].fields.filter(f => !onlyNum || f.type === 'number'); const groups = [...new Set(fs.map(f => f.group || ''))];
      return groups.map(g => `${g ? `<optgroup label="${esc(g)}">` : ''}${fs.filter(f => (f.group || '') === g).map(f => `<option value="${f.field}" ${f.field === sel ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}${g ? '</optgroup>' : ''}`).join(''); };
    const draw = () => {
      const ds = r.dataset, item = ds !== 'well';
      const tips = {well: 'Use {field} to insert a value, e.g. {casing_pct_of_maasp}.', test: 'Use {matches} for the matching tests, {match_count} for how many, or {test_type}, {days_overdue}... from the first match.', event: 'Use {matches} for the matching events, {match_count} for how many, or {category}, {event_date}... from the first match.'}[ds];
      $('#edbox').innerHTML = `<div class="ed"><div style="display:flex;align-items:center"><h2 style="margin:0;font-size:18px">${isNew ? 'New flag rule' : 'Edit flag rule'}</h2>
        <button class="btn sec" style="margin-left:auto" id="edx">Cancel</button></div>
        <label>Rule name</label><input type="text" id="e-name" value="${esc(r.name)}" placeholder="e.g. Sour wells: H2S detector calibration overdue">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px">
          <div><label>Severity</label><select id="e-sev">${['Critical', 'Warning', 'Review'].map(s => `<option ${s === r.severity ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
          <div><label>Weight (points)</label><input type="text" id="e-wt" value="${esc(r.weight)}"></div>
          <div><label>Category <span class="muted" style="font-weight:400">· "Safety" ranks first</span></label><input type="text" id="e-cat" list="e-cats" value="${esc(r.category || '')}"><datalist id="e-cats"><option value="Safety"><option value="Performance"><option value="Downtime"><option value="Economics"><option value="Data"></datalist></div>
          <div><label>Look at</label><select id="e-ds">${Object.entries(F.DATASETS).map(([k, v]) => `<option value="${k}" ${k === ds ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div><label>Group <span class="muted" style="font-weight:400">· rules about the same problem count once</span></label><input type="text" id="e-grp" list="e-grps" value="${esc(r.group || '')}" placeholder="optional"><datalist id="e-grps">${[...new Set(RULES.map(x => x.group).filter(Boolean))].map(g => `<option value="${esc(g)}">`).join('')}</datalist></div>
          <div><label>Typical fix cost (CAD) <span class="muted" style="font-weight:400">· for payback ranking; optional</span></label><input type="text" id="e-cost" value="${esc(r.fix_cost ?? '')}" placeholder="e.g. 15000"></div></div>
        <div style="display:grid;grid-template-columns:${item ? '1fr 1fr' : '1fr'};gap:10px">
          <div><label>${item ? `${ds === "test" ? "A test" : "An event"} matches when` : 'Flag a well when'}</label><select id="e-match"><option value="all" ${r.match !== 'any' ? 'selected' : ''}>all conditions are true</option><option value="any" ${r.match === 'any' ? 'selected' : ''}>any condition is true</option></select></div>
          ${item ? `<div><label>Flag the well when at least this many match</label><input type="text" id="e-min" value="${esc(r.min_count || 1)}"></div>` : ''}</div>
        <label>Conditions</label>
        ${r.conditions.map((cn, k) => { const f = F.fieldOf(ds, cn.field) || F.DATASETS[ds].fields[0]; const ops = F.OPS[f.type];
          return `<div class="crow" data-k="${k}"><select class="c-f">${fieldOpts(ds, cn.field)}</select>
            <select class="c-op">${ops.map(([o, l]) => `<option value="${o}" ${o === cn.op ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
            ${F.NEEDS_FIELD.has(cn.op) ? `<select class="c-v">${fieldOpts(ds, cn.value, true)}</select>`
              : F.NEEDS_VALUE.has(cn.op) ? `<input class="c-v" type="text" value="${esc(cn.value ?? '')}" placeholder="${f.type === 'text' ? 'value' : f.type === 'date' ? 'days' : 'number'}">` : '<span></span>'}
            <button class="btn danger c-del" title="Remove condition" aria-label="Remove condition">${ic('x', 'md')}</button></div>
            <div class="note" style="margin:-3px 0 6px">${esc(f.help)}</div>`; }).join('')}
        <button class="btn sec" id="e-add">+ Add condition</button>
        <label>Message on the flag <span class="muted" style="font-weight:400">· ${esc(tips)}</span></label>
        <textarea id="e-msg">${esc(r.message)}</textarea>
        <label>Suggested next step</label><textarea id="e-act">${esc(r.action)}</textarea>
        <div class="preview" id="e-prev"></div><div class="errs" id="e-err"></div>
        <div style="display:flex;gap:8px;margin-top:14px">${locked ? '' : `<button class="btn" id="e-save">Save rule</button>${isNew ? '' : '<button class="btn danger" id="e-delrule">Delete rule</button>'}`}</div></div>`;
      if (locked) {
        $('#edbox').querySelectorAll('input, select, textarea, button:not(#edx)').forEach(el => { el.disabled = true; });
        $('#edbox').querySelector('h2').textContent = 'Built-in safety rule';
        $('#edbox').querySelector('h2').parentElement.insertAdjacentHTML('afterend', '<div class="note" style="font-weight:600;margin:8px 0">This safety rule is set by the operator. It is always on and can\'t be changed or deleted here. Use Copy on the rule list to make a stricter version of your own.</div>');
      }
      const sync = () => {
        r.name = $('#e-name').value; r.severity = $('#e-sev').value; r.category = $('#e-cat').value; r.match = $('#e-match').value;
        r.weight = $('#e-wt').value === '' || isNaN(Number($('#e-wt').value)) ? $('#e-wt').value : Number($('#e-wt').value);
        if ($('#e-min')) r.min_count = isNaN(Number($('#e-min').value)) ? $('#e-min').value : Number($('#e-min').value); else delete r.min_count;
        r.message = $('#e-msg').value; r.action = $('#e-act').value;
        r.group = $('#e-grp').value.trim() || undefined; const fc = $('#e-cost').value.replace(/[$,\s]/g, ''); r.fix_cost = fc === '' ? undefined : (isNaN(Number(fc)) ? fc : Number(fc));
        document.querySelectorAll('.crow').forEach(row => { const cn = r.conditions[+row.dataset.k]; cn.field = row.querySelector('.c-f').value; cn.op = row.querySelector('.c-op').value;
          const v = row.querySelector('.c-v'); const ft = (F.fieldOf(r.dataset, cn.field) || {}).type;
          cn.value = v ? (F.NEEDS_FIELD.has(cn.op) || ft === 'text' ? v.value : (isNaN(Number(v.value)) || v.value === '' ? v.value : Number(v.value))) : undefined; });
      };
      const preview = () => {
        sync(); const errs = F.validateRule(r);
        $('#e-err').textContent = errs.join(' ');
        if (errs.length) { $('#e-prev').innerHTML = '<span class="muted">Finish the rule to preview.</span>'; return; }
        const mine = myWells(); const hits = F.evaluate(mine, [Object.assign({}, r, {enabled: true})], D.today, ITEMS);
        $('#e-prev').innerHTML = `<b>Preview:</b> this rule would flag ${hits.length} of your ${mine.length} wells${hits.length ? ': ' : '.'}` +
          hits.slice(0, 8).map(h => `<div style="margin-top:4px"><b>${esc(h.well_id)}</b> ${esc(h.well_name)} · <span class="muted">${esc(h.message || '(no message)')}</span></div>`).join('') + (hits.length > 8 ? `<div class="muted">and ${hits.length - 8} more</div>` : '');
      };
      document.querySelectorAll('#edbox input, #edbox textarea').forEach(el => el.oninput = preview);
      document.querySelectorAll('#edbox select').forEach(el => el.onchange = () => {
        if (el.id === 'e-ds') { sync(); r.dataset = el.value; r.conditions = [{field: F.DATASETS[r.dataset].fields[0].field, op: 'eq', value: ''}]; if (r.dataset === 'well') r.conditions = [{field: 'casing_pct_of_maasp', op: 'gte', value: 70}];
          if (r.dataset !== 'well') r.min_count = 1; draw(); return; }
        sync();
        if (el.classList.contains('c-f')) { const cn = r.conditions[+el.closest('.crow').dataset.k]; cn.op = F.OPS[F.fieldOf(r.dataset, cn.field).type][0][0]; cn.value = ''; }
        if (el.classList.contains('c-op')) { const cn = r.conditions[+el.closest('.crow').dataset.k]; if (F.NEEDS_FIELD.has(cn.op) && !F.fieldOf(r.dataset, cn.value)) cn.value = F.DATASETS[r.dataset].fields.find(f => f.type === 'number').field; if (!F.NEEDS_FIELD.has(cn.op) && F.fieldOf(r.dataset, cn.value)) cn.value = ''; }
        draw();
      });
      document.querySelectorAll('.c-del').forEach(b => b.onclick = () => { sync(); r.conditions.splice(+b.closest('.crow').dataset.k, 1); draw(); });
      $('#e-add').onclick = () => { sync(); const f0 = F.DATASETS[r.dataset].fields[0]; r.conditions.push({field: f0.field, op: F.OPS[f0.type][0][0], value: ''}); draw(); };
      $('#edx').onclick = () => $('#editor').hidden = true;
      if (!locked) $('#e-save').onclick = async () => { sync(); const errs = F.validateRule(r); if (errs.length) { $('#e-err').textContent = errs.join(' '); return; }
        if (isNew) RULES.push(r); else RULES[i] = r; $('#editor').hidden = true; await persist(`Rule "${r.name}" saved`); };
      if (!isNew && !locked) $('#e-delrule').onclick = async () => { const name = RULES[i].name; RULES.splice(i, 1); $('#editor').hidden = true; await persist(`Rule "${name}" deleted`); };
      preview();
    };
    draw(); $('#editor').hidden = false;
  }

  // ---------------- Alerts: Greg drafts, the checker reviews, the engineer approves ----------------
  const alertable = f => !f.handled && (f.severity === 'Critical' || (f.severity === 'Warning' && F.isSafety(f)));
  const myTasks = () => D.alert_tasks.filter(t => t.engineer_id === ENG);
  const openTaskFor = (w, r) => myTasks().find(t => t.well_id === w && t.rule_id === r && t.status === 'Open');
  const needsAlert = () => RANK.flatMap(r => r.flags.filter(f => alertable(f) && f.counted !== false && !openTaskFor(f.well_id, f.rule_id)).map(f => ({r, f})))
    .sort((a, b) => ({Critical: 0, Warning: 1, Review: 2}[a.f.severity] - {Critical: 0, Warning: 1, Review: 2}[b.f.severity]) || (F.isSafety(b.f) - F.isSafety(a.f)) || (b.f.weight - a.f.weight));
  const siblings = (r, f) => { const g = (RULES.find(x => x.id === f.rule_id) || {}).group; return g && r ? r.flags.filter(x => x !== f && !x.handled && (RULES.find(y => y.id === x.rule_id) || {}).group === g) : []; };
  function applySim() { const w = D.snapshot.find(x => x.well_id === SIM.well_id); if (w) Object.assign(w, SIM.values); }
  function simulateSpike(id) {
    clearSim(false);
    const w = D.snapshot.find(x => x.well_id === id), maasp = Number(w.prod_casing_maasp_psi);
    const peak = Math.round(maasp * 0.94), avg = Math.round(maasp * 0.9);
    SIM = {well_id: id, orig: {casing_psi_max_7d: w.casing_psi_max_7d, casing_pct_of_maasp: w.casing_pct_of_maasp, casing_psi_change: w.casing_psi_change, casing_psi_7d: w.casing_psi_7d},
      values: {casing_psi_max_7d: peak, casing_pct_of_maasp: 94, casing_psi_change: Math.round(avg - Number(w.casing_psi_7d || 0)), casing_psi_7d: avg}};
    applySim(); recompute(); render();
    toast(`New SCADA reading: ${id} production casing at ${fmt(peak)} psi, 94% of MAASP`);
    const r = RANK.find(x => x.well_id === id), f = r && r.flags.find(x => x.rule_id === 'SAFE_CASING_NEAR_MAASP') || (r && r.flags.find(alertable));
    if (f) setTimeout(() => openAlert(f, {auto: true}), 900);
  }
  function clearSim(rerender = true) {
    if (!SIM) return; const w = D.snapshot.find(x => x.well_id === SIM.well_id); if (w) Object.assign(w, SIM.orig);
    SIM = null; if (rerender) { recompute(); render(); toast('Simulation cleared'); }
  }
  function renderSimBar() {
    let b = $('#simbar'); if (!SIM) { if (b) b.remove(); return; }
    if (!b) { $('.dk-page-head').insertAdjacentHTML('afterend', '<div class="simbar" id="simbar"></div>'); b = $('#simbar'); }
    b.innerHTML = `${ic('alert')} <span><b>Demo:</b> simulated SCADA reading on <b>${SIM.well_id}</b>, production casing ${fmt(SIM.values.casing_psi_max_7d)} psi (94% of MAASP). Real data is unchanged.</span><button class="btn sec small" id="simclear" style="margin-left:auto">Clear simulation</button>`;
    $('#simclear').onclick = () => clearSim();
  }
  // ---------------- Safety incidents: report, make safe, notify, investigate, close ----------------
  // Safety always comes first. People move an incident on; the app and the AI never close, downgrade or delay one.
  // Notifications are simulated in this demo (recorded, not sent). The audit trail is insert-only.
  let INC = null, incErr = null, incTimer = null;
  const INC_STATES = ['Reported', 'Made Safe', 'Notified', 'Under Investigation', 'Corrective Actions Open', 'Closed'];
  const tsLocal = v => { if (!v) return ''; const d = new Date(String(v).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? '' : 'Z')); return isNaN(d) ? String(v) : d.toLocaleString('en-US', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}); };
  const agoMin = v => { const d = new Date(String(v).replace(' ', 'T') + (/[zZ]$/.test(String(v)) ? '' : 'Z')); return Math.max(0, Math.round((Date.now() - d) / 60000)); };
  const agoText = v => { const m = agoMin(v); return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  async function loadIncidents() {
    try { INC = await api('api/incidents'); incErr = null; } catch (e) { incErr = e.message; }
    const open = (INC ? INC.incidents : []).filter(i => i.state !== 'Closed'), waiting = open.filter(i => !i.acknowledged);
    const c = $('#c-inc'); if (c) { c.textContent = open.length || ''; c.classList.toggle('alarm', waiting.length > 0); c.title = waiting.length ? `${waiting.length} not acknowledged yet` : ''; }
  }
  // While the tab is open, check every minute: that is also when an overdue escalation goes out.
  function watchIncidents(on) {
    clearInterval(incTimer); incTimer = null;
    if (on) incTimer = setInterval(async () => { await loadIncidents(); if (view === 'incidents' && $('#modal').hidden) renderIncidents(); }, 60000);
  }
  const incPill = s => `<span class="pill ${s === 'Closed' ? 'ok' : s === 'Reported' ? 'crit' : 'warn'}">${esc(s)}</span>`;
  const stepsBar = s => `<ol class="incsteps">${INC_STATES.map((x, k) => `<li class="${k < INC_STATES.indexOf(s) ? 'done' : k === INC_STATES.indexOf(s) ? 'now' : ''}">${esc(x)}</li>`).join('')}</ol>`;

  function emergencyBox(info, compact) {
    const people = (info && info.contacts) || [];
    return `<div class="emerg" role="note"><b>${ic('alert')} Safety first</b>
      <ul><li><b>If anyone is hurt, there is a fire, or a release you can't control: call 911 now.</b></li>
        <li>Stop the work if it is unsafe. Anyone can stop work (Stop Work Authority).</li>
        ${compact ? '' : '<li>Make the area safe only if you can do it without putting yourself or others at risk. Move upwind of any gas.</li>'}
        <li>Company emergency line: <a href="tel:${esc((info && info.emergency_line) || '')}">${esc((info && info.emergency_line) || '')}</a>${people.map(p => ` · ${esc(p.role)} ${esc(p.name)}: <a href="tel:${esc(p.mobile || '')}">${esc(p.mobile || '')}</a>`).join('')}</li></ul>
      <div class="muted small">This app guides you; it doesn't replace your emergency response plan.</div></div>`;
  }

  async function reportIncident(pre = {}) {
    const wells = D.snapshot.slice().sort((a, b) => (b.engineer_id === ENG) - (a.engineer_id === ENG) || a.well_id.localeCompare(b.well_id));
    let well = pre.well_id || (myWells()[0] || wells[0]).well_id, info = null;
    const step1 = async () => {
      try { info = await api('api/incidents/emergency/' + well); } catch (e) { info = {emergency_line: (INC && INC.emergency_line) || '', contacts: []}; }
      showModal(`<div class="mhead"><h2>Report a safety issue</h2><button class="btn sec close" id="mx">Cancel</button></div><div class="mbody">
        ${emergencyBox(info)}
        <div class="frm" style="grid-template-columns:1fr"><div><label>Where</label><select id="r-well">${wells.map(w => `<option value="${w.well_id}" ${w.well_id === well ? 'selected' : ''}>${w.well_id} · ${esc(w.well_name)} · ${esc(w.area)}${w.engineer_id === ENG ? '' : ' (not your well)'}</option>`).join('')}</select></div></div>
        <div style="margin-top:14px;display:flex;gap:8px"><button class="btn" id="r-next">Continue to the report</button></div></div>`);
      $('#r-well').onchange = async e => { well = e.target.value; await step1(); };
      $('#r-next').onclick = step2;
    };
    const step2 = () => {
      const sr = window.SpeechRecognition || window.webkitSpeechRecognition;
      showModal(`<div class="mhead"><h2>Report a safety issue · ${esc(well)}</h2><button class="btn sec close" id="mx">Cancel</button></div><div class="mbody">
        ${emergencyBox(info, true)}
        <div class="frm">
          <div><label>What kind of issue</label><select id="r-cat">${INC.categories.map(c => `<option ${c === pre.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
          <div><label>Is anyone hurt?</label><div class="seg" id="r-hurt" role="radiogroup">${['Yes', 'No', 'Unknown'].map(h => `<button type="button" role="radio" data-h="${h}" class="${h === 'Unknown' ? 'on' : ''}" aria-checked="${h === 'Unknown'}">${h}</button>`).join('')}</div></div>
          <div class="full"><label>What happened, in your own words${sr ? ' (type or dictate)' : ''}</label><textarea id="r-text" placeholder="e.g. Rotten-egg smell at the wellhead, my personal monitor alarmed at 15 ppm, we backed off upwind and stopped work">${esc(pre.text || '')}</textarea>
            ${sr ? '<button type="button" class="btn sec small" id="r-mic" style="margin-top:6px">Dictate</button> <span class="muted small" id="r-micnote"></span>' : ''}</div>
          <div><label>Substance, if known <span class="muted" style="font-weight:400">· optional</span></label><input id="r-sub" placeholder="e.g. sour gas, produced water, crude oil"></div>
          <div><label>Estimated volume, m3 <span class="muted" style="font-weight:400">· optional</span></label><input id="r-vol" inputmode="decimal"></div>
        </div>
        <div class="note">Sending notifies the on-call chain for this area at once: the field foreman and HSE advisor. If nobody acknowledges, it escalates automatically. In this demo the notifications are recorded, not actually sent.</div>
        <div class="errs" id="ferr"></div>
        <div style="margin-top:14px;display:flex;gap:8px"><button class="btn danger-solid" id="r-send">${ic('alert')} Send report</button><button class="btn sec" id="r-back">Back</button></div></div>`);
      let hurt = 'Unknown';
      document.querySelectorAll('[data-h]').forEach(b => b.onclick = () => { hurt = b.dataset.h; document.querySelectorAll('[data-h]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); }); });
      $('#r-back').onclick = step1;
      if (sr && $('#r-mic')) {
        let rec = null;
        $('#r-mic').onclick = () => {
          if (rec) { rec.stop(); return; }
          rec = new sr(); rec.lang = 'en-US'; rec.interimResults = false; rec.continuous = true;
          const before = $('#r-text').value;
          rec.onresult = ev => { $('#r-text').value = (before ? before + ' ' : '') + [...ev.results].map(r => r[0].transcript).join(' '); };
          rec.onend = () => { rec = null; $('#r-mic').textContent = 'Dictate'; $('#r-micnote').textContent = 'Check the text before sending.'; };
          rec.onerror = ev => { $('#r-micnote').textContent = 'Dictation stopped: ' + ev.error; };
          rec.start(); $('#r-mic').textContent = 'Stop dictating'; $('#r-micnote').textContent = 'Listening…';
        };
      }
      $('#r-send').onclick = async () => {
        $('#r-send').disabled = true;
        try {
          const res = await post('api/incidents', {well_id: well, category: $('#r-cat').value, what_happened: $('#r-text').value, people_hurt: hurt,
            substance: $('#r-sub').value, volume_m3: $('#r-vol').value, source_rule_id: pre.source_rule_id || null});
          await loadIncidents();
          showModal(`<div class="mhead"><h2>Report sent · ${esc(res.incident_id)}</h2><button class="btn sec close" id="mx">Close</button></div><div class="mbody">
            <div class="note" style="font-weight:600">Alert sent to: ${res.notified.length ? res.notified.map(esc).join('; ') : 'nobody: no on-call contacts found for this area. Call the emergency line.'}</div>
            <div class="note">Simulated in this demo: recorded with the time and channel, not actually sent. If nobody acknowledges, it escalates on its own.</div>
            <div style="margin-top:14px;display:flex;gap:8px"><button class="btn" id="r-open">Open the incident</button></div></div>`);
          $('#r-open').onclick = () => openIncident(res.incident_id);
          if (view === 'incidents') renderIncidents();
        } catch (e) { $('#ferr').textContent = e.message; $('#r-send').disabled = false; }
      };
    };
    if (!INC) await loadIncidents();
    if (!INC) { toast('Could not load the incident setup: ' + (incErr || '') + '. Call the emergency line if this is urgent.'); return; }
    await step1();
  }

  function renderIncidents() {
    if (!INC) {
      $('#main').innerHTML = incErr ? `<div class="errcard"><b>Couldn't load safety incidents.</b><div>${esc(incErr)}</div><button class="btn" id="incretry">Try again</button></div>` : '<div class="card" style="padding:20px"><span class="skel" style="height:16px;width:60%;margin:10px 0"></span><span class="skel" style="height:16px;width:80%;margin:10px 0"></span></div>';
      if ($('#incretry')) $('#incretry').onclick = async () => { await loadIncidents(); renderIncidents(); };
      if (!incErr) loadIncidents().then(renderIncidents);
      return;
    }
    const all = INC.incidents, open = all.filter(i => i.state !== 'Closed'), closed = all.filter(i => i.state === 'Closed');
    const waiting = open.filter(i => !i.acknowledged), acts = open.flatMap(i => i.actions.filter(a => a.status !== 'Done'));
    const late = acts.filter(a => String(a.due_date) < D.today);
    const chain = INC.oncall, steps = [...new Set(chain.map(c => c.step))];
    const card = i => `<div class="inccard ${i.state === 'Closed' ? 'closed' : ''}" data-inc="${esc(i.incident_id)}" tabindex="0" role="button" aria-label="Open ${esc(i.incident_id)}">
      <div class="inchead"><b>${esc(i.incident_id)}</b> ${incPill(i.state)} <span>${esc(i.category)}</span> · <a class="lk" data-well="${esc(i.well_id)}">${esc(i.well_id)}</a> <span class="muted">${esc(i.area || '')}</span>
        <span class="muted small" style="margin-left:auto">reported ${esc(agoText(i.reported_at))} by ${esc(i.reported_by)}</span></div>
      <div class="incwhat">${esc(i.what_happened)}</div>
      <div class="small">${i.state === 'Closed' ? '' : i.acknowledged ? `<span class="pill ok">${ic('check')} Acknowledged</span>` : `<span class="pill crit">${ic('alert')} Not acknowledged yet</span>${i.next_escalation ? ` <span class="muted">escalates to ${esc(i.next_escalation.roles.join(' and '))} at ${esc(tsLocal(i.next_escalation.at))}</span>` : ''}`}
        ${i.people_hurt === 'Yes' ? ' <span class="pill crit">Someone hurt</span>' : ''}
        ${i.actions.length ? ` <span class="muted">· ${i.actions.filter(a => a.status !== 'Done').length} of ${i.actions.length} actions open</span>` : ''}</div></div>`;
    $('#main').innerHTML = `
      <div class="bar"><button class="btn danger-solid" id="increport">${ic('alert')} Report safety issue</button>
        <span class="note" style="margin-left:8px">Safety issues always come first. The app notifies the on-call chain and keeps the record; people decide every step.</span></div>
      <div class="kpis">
        <div class="kpi ${open.length ? 'warn' : ''}"><div class="n">${open.length}</div><div class="l">Open incidents</div></div>
        <div class="kpi ${waiting.length ? 'kpi-alert' : ''}"><div class="n">${waiting.length}</div><div class="l">Not acknowledged yet</div></div>
        <div class="kpi"><div class="n">${acts.length}</div><div class="l">Corrective actions open</div></div>
        <div class="kpi ${late.length ? 'crit' : ''}"><div class="n">${late.length}</div><div class="l">Actions past due</div></div></div>
      <div class="card" style="padding:14px 18px;margin-bottom:12px"><b>On-call chain</b> <span class="muted small">· from <a class="lk" href="${esc(tableUrl(SCH() + '.gold_incident_oncall'))}" target="_blank" rel="noopener">gold_incident_oncall</a>, set by operations</span>
        <div class="small" style="margin-top:4px">${steps.map(s => { const c = chain.filter(x => x.step === s); return `<div>${c[0].after_minutes ? `After ${c[0].after_minutes} min with no acknowledgement` : 'At once'}: ${c.map(x => `${esc(x.role)} (${esc(x.channels.replace(/,/g, ', '))})`).join(', ')}</div>`; }).join('')}</div>
        <div class="muted small" style="margin-top:4px">Demo: notifications are recorded with who, when and which channel, not actually sent. Escalations go out when the app next checks, at least once a minute while this tab is open.</div></div>
      <h3 style="margin:16px 0 8px">Open <span class="muted small">${open.length}</span></h3>
      ${open.length ? open.map(card).join('') : '<div class="card" style="padding:16px">No open safety incidents. Use <b>Report safety issue</b> to raise one: it takes a few taps.</div>'}
      ${closed.length ? `<details style="margin-top:16px"><summary><b>Closed</b> <span class="muted small">${closed.length}</span></summary>${closed.map(card).join('')}</details>` : ''}`;
    $('#increport').onclick = () => reportIncident();
    document.querySelectorAll('[data-inc]').forEach(c => { const open1 = e => { if (e.target.closest('[data-well]')) return; openIncident(c.dataset.inc); };
      c.onclick = open1; c.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open1(e); } }; });
    bindCommon($('#main'));
  }

  async function openIncident(id, keep = {}) {
    if (!INC || !INC.incidents.some(i => i.incident_id === id)) await loadIncidents();
    const i = INC && INC.incidents.find(x => x.incident_id === id);
    if (!i) { toast('Could not find ' + id); return; }
    const s = i.state, k = INC_STATES.indexOf(s), doneActs = i.actions.every(a => a.status === 'Done');
    const next = s === 'Closed' ? null : INC_STATES[k + 1];
    const nextForm = {
      'Made Safe': `<label>What was done to make the area safe</label><textarea id="t-note" placeholder="e.g. Well shut in at the wellhead, area barricaded, H2S monitor reading 0 ppm at the lease edge"></textarea>`,
      'Notified': i.acknowledged ? '<div class="note">The on-call chain has acknowledged. Confirm that everyone who needs to know has been told.</div><label>Note (optional)</label><textarea id="t-note"></textarea>'
        : '<div class="note" style="font-weight:600">Waiting for someone in the on-call chain to acknowledge the alert (see Notifications below).</div>',
      'Under Investigation': `<label>Who is leading the investigation</label><input id="t-lead" placeholder="e.g. Amara Okafor (HSE advisor)">`,
      'Corrective Actions Open': `<label>Root cause found by the investigation</label><textarea id="t-rc"></textarea>${i.actions.length ? '' : '<div class="note" style="font-weight:600">Add at least one corrective action below first.</div>'}`,
      'Closed': `${doneActs ? '' : '<div class="note" style="font-weight:600">Every corrective action must be done before closing.</div>'}<label>Closing note</label><textarea id="t-note"></textarea>`,
    }[next];
    const canNext = next && !(next === 'Notified' && !i.acknowledged) && !(next === 'Corrective Actions Open' && !i.actions.length) && !(next === 'Closed' && !doneActs);
    const prompts = i.reporting_prompts;
    showModal(`<div class="mhead"><h2>${esc(i.incident_id)} · ${esc(i.category)} · ${esc(i.well_id)}</h2><button class="btn sec close" id="mx">Close</button></div><div class="mbody">
      ${stepsBar(s)}
      ${s === 'Reported' ? emergencyBox({emergency_line: INC.emergency_line, contacts: []}, true) : ''}
      <div class="incgrid"><div>
        <h3>Next step</h3>
        ${next ? `<div class="card incnext" style="padding:12px 14px"><b>${esc(next)}</b>${nextForm}<div class="errs" id="t-err"></div>
            <button class="btn" id="t-go" ${canNext ? '' : 'disabled'} style="margin-top:8px">Move to ${esc(next)}</button></div>`
          : `<div class="card" style="padding:12px 14px">Closed by ${esc(i.updated_by)} · ${esc(i.closing_note || '')}<div style="margin-top:8px"><button class="btn sec" id="t-reopen">Reopen for investigation</button></div></div>`}
        <h3>What was reported</h3>
        <div class="incfacts">
          <div><span>In the reporter's words</span>${esc(i.what_happened)}</div>
          <div><span>Anyone hurt</span>${esc(i.people_hurt)}</div>
          <div><span>Where</span>${esc(i.location || i.well_id)}</div>
          <div><span>When</span>${esc(tsLocal(i.occurred_at))}</div>
          <div><span>Substance</span>${esc(i.substance || '')}</div>
          <div><span>Volume</span>${i.volume_m3 !== null && i.volume_m3 !== undefined ? esc(fmt(i.volume_m3, 1)) + ' m3' : ''}</div>
          <div><span>Reported by</span>${esc(i.reported_by)} · ${esc(tsLocal(i.reported_at))}</div>
          ${i.source_rule_id ? `<div><span>Raised from flag</span>${esc((RULES.find(r => r.id === i.source_rule_id) || {}).name || i.source_rule_id)}</div>` : ''}
          ${i.made_safe_note ? `<div><span>Made safe</span>${esc(i.made_safe_note)}</div>` : ''}
          ${i.investigation_lead ? `<div><span>Investigation lead</span>${esc(i.investigation_lead)}</div>` : ''}
          ${i.root_cause ? `<div><span>Root cause</span>${esc(i.root_cause)}</div>` : ''}
        </div>
        <div style="margin-top:10px"><button class="btn sec small" id="ai-go">${ic('flag')} Structure this report with AI</button> <span class="muted small">Suggests fields from the reporter's words, each with the words it came from. Nothing changes until you accept.</span></div>
        <div id="ai-box"></div>
        <h3>Regulatory reporting</h3>
        <div class="card" style="padding:12px 14px">
          ${prompts.length ? prompts.map(p => `<div style="margin-bottom:8px">${ic('alert')} <b>A report to the regulator may be required.</b> ${esc(p.text)} <span class="muted">Decided by the ${esc(p.decided_by_role.toLowerCase())}.</span></div>`).join('')
            : '<div style="margin-bottom:8px">No reporting prompt matched the configured rules. That does not mean no report is needed: the regulatory coordinator decides.</div>'}
          <div class="muted small">Prompts come from <a class="lk" href="${esc(tableUrl(SCH() + '.gold_reporting_prompts'))}" target="_blank" rel="noopener">gold_reporting_prompts</a> (demo examples, not legal advice). The app never decides whether to report.</div>
          ${i.regulatory_decision ? `<div style="margin-top:8px"><b>Decision recorded:</b> ${esc(i.regulatory_decision)} <span class="muted">(${esc(i.regulatory_decided_by)})</span></div>` : ''}
          <details style="margin-top:8px"><summary class="lk">Record the decision (qualified person)</summary>
            <div class="frm"><div><label>Decision</label><select id="rg-d"><option>Still deciding</option><option>Report made to the regulator</option><option>Decided no report needed</option></select></div>
              <div><label>Decided by</label><input id="rg-by" placeholder="Name and role"></div><div class="full"><label>Reason or reference</label><textarea id="rg-why"></textarea></div></div>
            <div class="errs" id="rg-err"></div><button class="btn sec" id="rg-save">Record decision</button></details></div>
      </div><div>
        <h3>Notifications</h3>
        ${i.next_escalation ? `<div class="note" style="font-weight:600">${ic('alert')} Not acknowledged yet. Escalates to ${esc(i.next_escalation.roles.join(' and '))} at ${esc(tsLocal(i.next_escalation.at))}.</div>` : ''}
        <table class="small"><thead><tr><th>Who</th><th>Channel</th><th>Sent</th><th>Status</th></tr></thead><tbody>
          ${i.notifications.map(n => `<tr><td><b>${esc(n.person)}</b><div class="muted">${esc(n.role)} · step ${n.step}</div></td><td>${esc(String(n.channels).replace(/,/g, ', '))}</td><td>${esc(tsLocal(n.sent_at))}</td>
            <td>${n.status === 'Acknowledged' ? `<span class="pill ok">${ic('check')} ${esc(tsLocal(n.acknowledged_at))}</span>` : `<button class="btn sec small" data-ack-n="${esc(n.notification_id)}" title="In production the person taps Acknowledge on their phone">Record acknowledgement</button>`}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No one was notified: no on-call contacts for this area.</td></tr>'}
        </tbody></table>
        <div class="muted small">Simulated: recorded with the time and channel, not actually sent.</div>
        <h3>Corrective actions</h3>
        ${i.actions.length ? `<table class="small"><tbody>${i.actions.map(a => `<tr><td>${a.status === 'Done' ? ic('check') : ''} <b>${esc(a.description)}</b><div class="muted">${esc(a.owner)} · due ${esc(String(a.due_date))}${a.status !== 'Done' && String(a.due_date) < D.today ? ' <span class="pill crit">past due</span>' : ''}${a.done_note ? ' · ' + esc(a.done_note) : ''}</div></td>
          <td style="white-space:nowrap">${a.status === 'Done' ? '<span class="pill ok">Done</span>' : `<button class="btn sec small" data-act-done="${esc(a.action_id)}">Mark done</button>`}</td></tr>`).join('')}</tbody></table>` : '<div class="muted small">None yet.</div>'}
        ${s !== 'Closed' ? `<details style="margin-top:6px"><summary class="lk">Add a corrective action</summary><div class="frm"><div class="full"><label>What will be done</label><input id="ca-d"></div><div><label>Owner</label><input id="ca-o"></div><div><label>Due</label><input id="ca-due" type="date" min="${D.today}"></div></div><div class="errs" id="ca-err"></div><button class="btn sec" id="ca-add">Add action</button></details>` : ''}
        <h3>Timeline</h3>
        <ol class="inctl">${i.events.map(e => `<li><span class="muted">${esc(tsLocal(e.at))}</span> <b>${esc(e.action)}</b>${e.to_state && e.from_state ? ` <span class="muted">${esc(e.from_state)} → ${esc(e.to_state)}</span>` : ''} · <span class="muted">${esc(e.actor)}</span>${e.detail ? `<div>${esc(e.detail)}</div>` : ''}</li>`).join('')}</ol>
        <div class="muted small">Insert-only audit trail (<a class="lk" href="${esc(tableUrl(SCH() + '.app_incident_events'))}" target="_blank" rel="noopener">app_incident_events</a>): entries are never edited or deleted.</div>
        <div class="frm" style="grid-template-columns:1fr;margin-top:8px"><div><label>Add a note to the timeline</label><textarea id="in-note" style="min-height:60px"></textarea></div></div><button class="btn sec small" id="in-add">Add note</button>
      </div></div></div>`);
    const again = async (msg) => { await loadIncidents(); if (view === 'incidents') renderIncidents(); await openIncident(id); if (msg) toast(msg); };
    const run = async (btn, errEl, fn, msg) => { btn.disabled = true; try { await fn(); await again(msg); } catch (e) { $(errEl).textContent = e.message; btn.disabled = false; } };
    if ($('#t-go')) $('#t-go').onclick = () => run($('#t-go'), '#t-err', () => post(`api/incidents/${id}/transition`, {to: next, note: val('t-note'), investigation_lead: val('t-lead'), root_cause: val('t-rc')}), `Moved to ${next}`);
    if ($('#t-reopen')) $('#t-reopen').onclick = () => run($('#t-reopen'), '#t-err', () => post(`api/incidents/${id}/transition`, {to: 'Under Investigation', note: 'Reopened'}), 'Reopened');
    document.querySelectorAll('[data-ack-n]').forEach(b => b.onclick = () => run(b, '#t-err', () => post(`api/incidents/${id}/acknowledge`, {notification_id: b.dataset.ackN}), 'Acknowledgement recorded'));
    document.querySelectorAll('[data-act-done]').forEach(b => b.onclick = () => {
      const aid = b.dataset.actDone, cell = b.parentElement;
      cell.innerHTML = `<input id="cd-${aid}" placeholder="How was it done?" style="min-width:180px"> <button class="btn sec small" id="cs-${aid}">Save</button>`;
      $('#cd-' + aid).focus();
      $('#cs-' + aid).onclick = () => run($('#cs-' + aid), '#ca-err', () => post(`api/incidents/${id}/actions/${aid}`, {status: 'Done', note: val('cd-' + aid)}), 'Action marked done');
    });
    if ($('#ca-add')) $('#ca-add').onclick = () => run($('#ca-add'), '#ca-err', () => post(`api/incidents/${id}/actions`, {description: val('ca-d'), owner: val('ca-o'), due_date: val('ca-due')}), 'Corrective action added');
    $('#in-add').onclick = () => run($('#in-add'), '#t-err', () => post(`api/incidents/${id}/notes`, {text: val('in-note')}), 'Note added');
    $('#rg-save').onclick = () => run($('#rg-save'), '#rg-err', () => post(`api/incidents/${id}/regulatory`, {decision: val('rg-d'), decided_by: val('rg-by'), reason: val('rg-why')}), 'Decision recorded');
    $('#ai-go').onclick = async () => {
      $('#ai-go').disabled = true; $('#ai-box').innerHTML = '<div class="working" style="margin-top:8px">The AI is reading the report…</div>';
      let sug;
      try { sug = await post(`api/incidents/${id}/structure`, {}); }
      catch (e) { $('#ai-box').innerHTML = `<div class="errcard"><b>The AI couldn't structure this report.</b><div>${esc(e.message)}</div></div>`; $('#ai-go').disabled = false; return; }
      const f = sug.fields, lab = {what: 'What happened', where: 'Where', when: 'When', who_involved: 'Who was involved', substance: 'Substance', volume_m3: 'Volume, m3', people_hurt: 'Anyone hurt'};
      $('#ai-box').innerHTML = `<div class="card aibox" style="padding:12px 14px;margin-top:8px"><b>AI suggestion</b> <span class="pill warn">not applied yet</span> <span class="muted small">${esc(sug.model || '')}${sug.secs ? ', ' + sug.secs + ' s' : ''}</span>
        <table class="small" style="margin-top:6px"><thead><tr><th>Field</th><th>Suggested</th><th>From the reporter's words</th></tr></thead><tbody>
        ${Object.entries(lab).filter(([k]) => f[k] !== undefined).map(([k, l]) => { const v = typeof f[k] === 'object' ? f[k].value : f[k], q = typeof f[k] === 'object' ? f[k].quote : '';
          const edit = k === 'substance' ? `<input id="ai-substance" value="${esc(v ?? '')}">` : k === 'volume_m3' ? `<input id="ai-volume" value="${esc(v ?? '')}" inputmode="decimal">` : k === 'people_hurt' ? `<select id="ai-hurt">${['Yes', 'No', 'Unknown'].map(h => `<option ${h === v ? 'selected' : ''}>${h}</option>`).join('')}</select>` : esc(v);
          return `<tr><td>${esc(l)}</td><td>${edit}</td><td class="muted">${q ? '“' + esc(q) + '”' : (k === 'people_hurt' ? 'Not stated' : '')}</td></tr>`; }).join('')}</tbody></table>
        ${sug.timeline.length ? `<div class="small" style="margin-top:6px"><b>Timeline the AI read in the text</b><ol>${sug.timeline.map(t => `<li>${t.time ? esc(t.time) + ': ' : ''}${esc(t.event)}</li>`).join('')}</ol></div>` : ''}
        ${sug.missing.length ? `<div class="small"><b>Not in the report yet</b> (ask the reporter): ${sug.missing.map(esc).join('; ')}</div>` : ''}
        ${sug.dropped.length ? `<div class="muted small">Left out because the text didn't support them: ${sug.dropped.map(d => esc(lab[d] || d)).join(', ')}.</div>` : ''}
        <div class="muted small">AI inference from the report text only. Only substance, volume and anyone hurt are saved to the record; the rest is for reference. Your choice is logged.</div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn sec small" data-ai="accepted">Accept</button><button class="btn sec small" data-ai="edited">Save with my edits</button><button class="btn sec small" data-ai="rejected">Reject</button></div><div class="errs" id="ai-err"></div></div>`;
      const orig = {substance: f.substance ? f.substance.value : '', volume_m3: f.volume_m3 ? f.volume_m3.value : '', people_hurt: f.people_hurt ? (f.people_hurt.value || f.people_hurt) : 'Unknown'};
      document.querySelectorAll('[data-ai]').forEach(b => b.onclick = () => {
        const cur = {substance: val('ai-substance') ?? orig.substance, volume_m3: val('ai-volume') ?? orig.volume_m3, people_hurt: val('ai-hurt') ?? orig.people_hurt};
        const fields = b.dataset.ai === 'accepted' ? orig : b.dataset.ai === 'edited' ? cur : {};
        const summary = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'object' ? v.value : v]));
        run(b, '#ai-err', () => post(`api/incidents/${id}/structure/decision`, {decision: b.dataset.ai, fields, summary}), `AI suggestion ${b.dataset.ai}`);
      });
    };
    if (keep.scroll) $('#mbox').scrollTop = keep.scroll;
  }

  function renderAlerts() {
    const need = needsAlert(), tasks = myTasks(), open = tasks.filter(t => t.status === 'Open');
    const late = open.filter(t => String(t.due_date) < D.today), done = tasks.filter(t => t.status === 'Done');
    const quiet = myWells().filter(w => !RANK.some(r => r.well_id === w.well_id && r.flags.some(f => /CASING/.test(f.rule_id)))).sort((a, b) => b.oil_7d_bopd - a.oil_7d_bopd);
    const demoDefault = (quiet.find(w => w.lift_type === 'ESP') || quiet[0] || {}).well_id;
    $('#main').innerHTML = `
      <div class="card" style="padding:16px 20px"><b style="font:700 16px/22px var(--dk-font-display)">Greg drafts the alerts for you</b>
        <div class="note" style="margin-top:4px">When a critical flag comes up, Greg (the alerting agent) works out who needs to know from the routing rules and the contact directory, then drafts an email, a Teams message and a text with the readings, the recommended next step and a due date. A second agent checks every draft against the data before you see it. Nothing is sent until you approve, and approving creates a follow-up task.</div>
        <div class="flow"><span>Flag raised</span>${ic('arrow')}<span>Who to notify</span>${ic('arrow')}<span>Greg drafts</span>${ic('arrow')}<span>Checker reviews</span>${ic('arrow')}<span>You approve</span>${ic('arrow')}<span>Follow-up task</span></div></div>
      <div class="card" style="padding:14px 20px;margin-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><b>Demo: simulate a pressure spike</b>
        <span class="note">Pretend a new SCADA reading puts a well's production casing at 94% of its MAASP. Greg drafts the alert straight away.</span>
        <select id="simwell" style="margin-left:auto">${quiet.map(w => `<option value="${w.well_id}" ${w.well_id === demoDefault ? 'selected' : ''}>${w.well_id} ${esc(w.well_name)} (${esc(w.lift_type)})</option>`).join('')}</select>
        <button class="btn" id="simgo">Simulate spike</button>${SIM ? '<button class="btn sec" id="simclear2">Clear simulation</button>' : ''}${tasks.some(t => t.simulated && t.status === 'Open') ? '<button class="btn sec" id="simreset" title="Cancel follow-up tasks from simulated readings so the demo can run again">Reset demo</button>' : ''}</div>
      <div class="kpis" style="grid-template-columns:repeat(4,1fr);margin-top:12px">
        <div class="kpi ${need.length ? 'kpi-alert' : ''}"><div class="n">${need.length}</div><div class="l">Flags that need an alert</div></div>
        <div class="kpi"><div class="n">${open.length}</div><div class="l">Open follow-up tasks</div></div>
        <div class="kpi ${late.length ? 'kpi-alert' : ''}"><div class="n">${late.length}</div><div class="l">Tasks past due</div></div>
        <div class="kpi"><div class="n">${done.length}</div><div class="l">Tasks done</div></div></div>
      <h3>Needs an alert (${need.length}) <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· critical flags, and safety warnings, with no open follow-up task</span></h3>
      <div class="card">${need.length ? `<table><thead><tr><th>Severity</th><th>Well</th><th>Flag</th><th></th></tr></thead><tbody>${need.map(({r, f}) => `<tr>
          <td><span class="sev ${f.severity}">${f.severity}</span></td><td><a class="lk" data-well="${f.well_id}"><b>${f.well_id}</b></a> <span class="muted small">${esc(r.fact.well_name)}</span>${SIM && SIM.well_id === f.well_id ? ' <span class="pill warn">simulated</span>' : ''}</td>
          <td>${F.isSafety(f) ? SAFETY_TAG : ''}<b>${esc(f.rule_name)}</b> <span class="muted">· ${esc(f.message)}</span></td>
          <td style="white-space:nowrap"><button class="btn small" data-galert='${esc(JSON.stringify({w: f.well_id, r: f.rule_id}))}'>Draft alert</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">Every critical flag has an alert and a follow-up task.</div>'}</div>
      <h3>Follow-up tasks (${tasks.length})</h3>
      <div class="card">${tasks.length ? `<table><thead><tr><th>Task</th><th>Well</th><th>Flag</th><th>Owner</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>${tasks.map(t => `<tr>
          <td><code class="small">${esc(t.task_id)}</code>${t.simulated ? ' <span class="pill warn">demo</span>' : ''}</td><td><a class="lk" data-well="${t.well_id}"><b>${t.well_id}</b></a></td>
          <td><span class="sev ${esc(t.severity)}">${esc(t.severity)}</span> ${esc(t.rule_name)}</td><td>${esc(t.owner_name)}<div class="muted small">${esc(t.owner_role)}</div></td>
          <td>${t.status === 'Open' && String(t.due_date) < D.today ? `<span class="pill crit">${ic('x')} ${esc(t.due_date)}</span>` : esc(t.due_date)}</td>
          <td>${t.status === 'Done' ? `<span class="pill ok">${ic('check')} Done</span>` : t.status === 'Cancelled' ? '<span class="pill">Cancelled</span>' : '<span class="pill warn">Open</span>'}</td>
          <td style="white-space:nowrap"><a class="lk" data-tview="${t.task_id}">messages</a> · ${t.status === 'Open' ? `<a class="lk" data-tdone="${t.task_id}">mark done</a>` : `<a class="lk" data-topen="${t.task_id}">reopen</a>`}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">No follow-up tasks yet. Approve an alert to create one.</div>'}</div>`;
    bindCommon($('#main'));
    $('#simgo').onclick = () => simulateSpike($('#simwell').value); if ($('#simclear2')) $('#simclear2').onclick = () => clearSim();
    if ($('#simreset')) $('#simreset').onclick = async () => { const r = await post('api/alerts/reset_demo', {engineer_id: ENG}); clearSim(false); await refresh(`Demo reset: ${r.cancelled} demo task${r.cancelled === 1 ? '' : 's'} cancelled`); };
    document.querySelectorAll('[data-galert]').forEach(b => b.onclick = () => { const {w, r} = JSON.parse(b.dataset.galert); openAlert(RANK.find(x => x.well_id === w).flags.find(f => f.rule_id === r)); });
    document.querySelectorAll('[data-tview]').forEach(a => a.onclick = () => viewTask(tasks.find(t => t.task_id === a.dataset.tview)));
    document.querySelectorAll('[data-tdone],[data-topen]').forEach(a => a.onclick = async () => {
      const id = a.dataset.tdone || a.dataset.topen; await post(`api/alerts/tasks/${id}/status`, {status: a.dataset.tdone ? 'Done' : 'Open'});
      await refresh(a.dataset.tdone ? 'Task marked done' : 'Task reopened'); });
  }
  const checksHtml = (checks, review, revised) => `<ul class="checks">${checks.map(c => `<li>${c.ok ? `<span class="ok">${ic('check')}</span>` : `<span class="bad">${ic('x')}</span>`}<span><b>${esc(c.name)}</b> <span class="muted">· ${esc(c.detail)}</span></span></li>`).join('')}
      ${review ? `<li>${review.verdict === 'pass' ? `<span class="ok">${ic('check')}</span>` : `<span class="bad">${ic('alert')}</span>`}<span><b>Model review: ${review.verdict === 'pass' ? 'accurate, right audience and urgency' : esc(review.verdict)}</b>${(review.issues || []).length ? `<br><span class="muted">${review.issues.map(esc).join('<br>')}</span>` : ''}</span></li>` : ''}</ul>
      ${revised ? `<div class="note" style="margin-top:6px">${ic('undo')} The checker sent the first draft back and Greg revised it. The checks above are on the revised version.</div>` : ''}`;
  async function openAlert(f, opts = {}) {
    const r = RANK.find(x => x.well_id === f.well_id), rule = RULES.find(x => x.id === f.rule_id) || {};
    const simulated = SIM && SIM.well_id === f.well_id ? SIM.values : null;
    showModal(`<div class="mhead"><h2>${opts.auto ? 'New critical flag · ' : ''}Alert for ${f.well_id} · ${esc(f.rule_name)}</h2><button class="btn sec close" id="mx">Close</button></div>
      <div class="mbody" id="abody"><div class="flag" style="margin:0 0 8px"><span class="sev ${f.severity}">${f.severity}</span><div class="msg">${F.isSafety(f) ? SAFETY_TAG : ''}<b>${esc(f.rule_name)}</b> · ${esc(f.message)}</div></div>
        <div class="working"><span class="dots muted">Greg is finding who to notify and drafting the alert; the checker reviews it before you see it</span></div></div>`);
    let res;
    const body = {well_id: f.well_id, engineer_id: ENG, engineer_name: engName(), simulated, report_url: location.origin + location.pathname + '#report/' + f.well_id,
      flag: {rule_id: f.rule_id, rule_name: f.rule_name, group: rule.group || '', category: f.category || rule.category, severity: f.severity, message: f.message, action: f.action,
        evidence: (f.evidence || []).map(e => ({label: e.label || '', value: String(e.value ?? '')})),
        related: siblings(r, f).map(x => ({rule_name: x.rule_name, message: x.message})),
        thresholds: (rule.conditions || []).filter(c => !['is_true', 'is_false'].includes(c.op)).map(c => { const fd = F.fieldOf(rule.dataset || 'well', c.field); return {measure: fd ? fd.label : c.field, flags_when: c.op, value: c.value}; })}};
    try { res = await post('api/alerts/draft', body); } catch (e) {
      $('#abody').insertAdjacentHTML('beforeend', `<div class="errcard"><b>Greg couldn't draft this alert.</b><div>${esc(e.message)}</div><button class="btn" id="aretry">Try again</button></div>`);
      $('.working').remove(); $('#aretry').onclick = () => openAlert(f, opts); return; }
    const prim = res.recipients.find(x => x.primary), cc = res.recipients.filter(x => !x.primary);
    let tab = 'email'; const d = Object.assign({}, res.drafts);
    $('#abody').innerHTML = `<div class="flag" style="margin:0 0 10px"><span class="sev ${f.severity}">${f.severity}</span><div class="msg">${F.isSafety(f) ? SAFETY_TAG : ''}<b>${esc(f.rule_name)}</b> · ${esc(f.message)}${res.simulated ? ' <span class="pill warn">simulated reading</span>' : ''}</div></div>${siblings(r, f).length ? `<fieldset class="note" style="margin:-4px 0 10px;border:1px solid var(--dk-border, #ccc);border-radius:8px;padding:8px 12px"><legend><b>Related flags on this well</b></legend>Tick each one this alert and follow-up task also cover. Unticked flags stay open as they are.${siblings(r, f).map((x, k) => `<label style="display:flex;gap:8px;margin-top:6px;cursor:pointer"><input type="checkbox" data-sib="${k}"> <span><b>${esc(x.rule_name)}</b> · ${esc(x.message)}</span></label>`).join('')}</fieldset>` : ''}
      <div class="alertgrid"><div>
        <h3 style="margin-top:0">Messages <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· edit anything before approving</span></h3>
        <div class="msgtabs"><button data-mt="email" class="on">Email</button>${prim.channels.includes('teams') ? '<button data-mt="teams">Teams</button>' : ''}${prim.channels.includes('text') ? '<button data-mt="text">Text</button>' : ''}</div>
        <div id="mpane"></div>
      </div><div>
        <h3 style="margin-top:0">Who gets it</h3>
        ${res.recipients.map(x => `<div style="margin-bottom:8px;font-size:13px"><b>${esc(x.name)}</b> · ${esc(x.role)}${x.primary ? ' <span class="pill">owns the task</span>' : ''}<div class="muted small">${esc(x.why)} · ${x.channels.join(', ')}</div></div>`).join('')}
        <div class="muted small">From the alert routing rules (<a class="lk" href="${esc(tableUrl(SCH() + '.gold_alert_routing'))}" target="_blank" rel="noopener">gold_alert_routing</a>) and the contact directory (<a class="lk" href="${esc(tableUrl(SCH() + '.gold_well_contacts'))}" target="_blank" rel="noopener">gold_well_contacts</a>), not chosen by the model.</div>
        <h3>What the agents did</h3>
        <ul class="agentsteps">${res.steps.map(s => `<li><span class="who">${esc(s.agent)}</span><span>${esc(s.action)}${s.secs !== undefined ? ` <span class="muted small">· ${esc(s.model || '')}, ${s.secs} s</span>` : ''}${(s.issues || []).length ? `<div class="iss">${s.issues.map(esc).join('<br>')}</div>` : ''}</span></li>`).join('')}</ul>
        <h3>Checker</h3>${checksHtml(res.checks, res.review, res.revised)}
        <h3>Follow-up task</h3>
        <div class="frm" style="grid-template-columns:1fr 1fr"><div><label>Owner</label><select id="a-owner">${res.recipients.map((x, i) => `<option value="${i}">${esc(x.name)} (${esc(x.role)})</option>`).join('')}</select></div>
          <div><label>Due</label><input id="a-due" type="date" value="${esc(res.due_date)}"></div></div>
        <div class="note">Approving records the owner and due date on this flag${F.isSafety(f) ? ' (it stays on the list because it is a safety flag)' : ', and it leaves the list until the due date; if the reading gets worse, it comes back'}. Related flags are covered only if you tick them above.</div>
      </div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;align-items:center">
        <button class="btn" id="aok">${ic('check')} Approve and create follow-up task</button>
        <a class="btn sec" id="amail" target="_blank" rel="noopener">Open in email app</a><button class="btn sec" id="acopy">Copy this message</button><button class="btn sec" id="aredo">Redraft</button>
        <span class="note" style="margin-left:auto">Nothing is sent from Well Watch. Send from your email or Teams.</span></div>`;
    const mailto = () => `mailto:${encodeURIComponent(prim.email)}?cc=${encodeURIComponent(cc.map(x => x.email).join(','))}&subject=${encodeURIComponent(d.email_subject || '')}&body=${encodeURIComponent(d.email_body || '')}`;
    const pane = () => {
      document.querySelectorAll('[data-mt]').forEach(b => b.classList.toggle('on', b.dataset.mt === tab));
      $('#mpane').innerHTML = tab === 'email' ? `<div class="addr">To: ${esc(prim.name)} &lt;${esc(prim.email)}&gt;${cc.length ? `<br>Cc: ${cc.map(x => esc(x.name)).join(', ')}` : ''}</div><input class="subj" id="m-subj" value="${esc(d.email_subject || '')}"><textarea id="m-body">${esc(d.email_body || '')}</textarea>`
        : tab === 'teams' ? `<div class="addr">Teams chat with ${esc(prim.name)} (${esc(prim.teams)})</div><textarea id="m-body" style="min-height:140px">${esc(d.teams_message || '')}</textarea>`
        : `<div class="addr">Text to ${esc(prim.name)}, ${esc(prim.mobile)}</div><textarea id="m-body" style="min-height:100px">${esc(d.text_message || '')}</textarea><div class="note" id="m-len">${(d.text_message || '').length} characters</div>`;
      const key = {email: 'email_body', teams: 'teams_message', text: 'text_message'}[tab];
      $('#m-body').oninput = e => { d[key] = e.target.value; if ($('#m-len')) $('#m-len').textContent = e.target.value.length + ' characters'; $('#amail').href = mailto(); };
      if ($('#m-subj')) $('#m-subj').oninput = e => { d.email_subject = e.target.value; $('#amail').href = mailto(); };
      $('#amail').href = mailto();
    };
    document.querySelectorAll('[data-mt]').forEach(b => b.onclick = () => { tab = b.dataset.mt; pane(); }); pane();
    $('#acopy').onclick = () => { const t = tab === 'email' ? `${d.email_subject}\n\n${d.email_body}` : tab === 'teams' ? d.teams_message : d.text_message;
      try { navigator.clipboard.writeText(t); toast('Copied'); } catch (e) { toast('Copy failed; select the text instead'); } };
    $('#aredo').onclick = () => openAlert(f, opts);
    $('#aok').onclick = async () => {
      const own = res.recipients[Number($('#a-owner').value)], due = $('#a-due').value;
      $('#aok').disabled = true;
      try {
        const t = await post('api/alerts/tasks', {engineer_id: ENG, well_id: f.well_id, rule_id: f.rule_id, rule_name: f.rule_name, severity: f.severity, owner: own, due_date: due,
          recipients: res.recipients, drafts: d, checks: res.checks.concat(res.review ? [{name: 'Model review', ok: res.review.verdict === 'pass', detail: (res.review.issues || []).join('; ')}] : []), simulated: !!res.simulated});
        await post('api/acks', {engineer_id: ENG, well_id: f.well_id, rule_id: f.rule_id, until_date: due, owner: `${own.name} (${own.role})`, safety: !!F.isSafety(f),
          note: `Alert approved; follow-up task ${t.task_id}`, snapshot: F.ackSnapshot(f, RULES.find(x => x.id === f.rule_id), r.fact)});
        const ticked = [...document.querySelectorAll('[data-sib]:checked')].map(c => siblings(r, f)[+c.dataset.sib]).filter(Boolean);
        for (const x of ticked) await post('api/acks', {engineer_id: ENG, well_id: x.well_id, rule_id: x.rule_id, until_date: due, owner: `${own.name} (${own.role})`, safety: !!F.isSafety(x),
          note: `Covered by alert task ${t.task_id} (${f.rule_name})`, snapshot: F.ackSnapshot(x, RULES.find(y => y.id === x.rule_id), r.fact)});
        $('#modal').hidden = true; await refresh(`Alert approved · task ${t.task_id} for ${own.name}`);
      } catch (e) { $('#aok').disabled = false; toast('Could not save: ' + e.message); }
    };
  }
  function viewTask(t) {
    let d = {}, ck = [], rc = []; try { d = JSON.parse(t.drafts_json || '{}'); ck = JSON.parse(t.checks_json || '[]'); rc = JSON.parse(t.recipients_json || '[]'); } catch (e) {}
    showModal(`<div class="mhead"><h2>Task ${esc(t.task_id)} · ${esc(t.well_id)} · ${esc(t.rule_name)}</h2><button class="btn sec close" id="mx">Close</button></div><div class="mbody">
      <div class="note">Owner ${esc(t.owner_name)} (${esc(t.owner_role)}) · due ${esc(t.due_date)} · status ${esc(t.status)} · approved by ${esc(t.created_by)}</div>
      <div class="alertgrid"><div><h3>Email</h3><div class="addr">To: ${rc.filter(x => x.primary).map(x => esc(x.name)).join(', ')}${rc.some(x => !x.primary) ? ' · Cc: ' + rc.filter(x => !x.primary).map(x => esc(x.name)).join(', ') : ''}</div>
        <b>${esc(d.email_subject || '')}</b><pre style="white-space:pre-wrap;font:13px/19px var(--dk-font-body)">${esc(d.email_body || '')}</pre>
        ${d.teams_message ? `<h3>Teams</h3><pre style="white-space:pre-wrap;font:13px/19px var(--dk-font-body)">${esc(d.teams_message)}</pre>` : ''}
        ${d.text_message ? `<h3>Text</h3><pre style="white-space:pre-wrap;font:13px/19px var(--dk-font-body)">${esc(d.text_message)}</pre>` : ''}</div>
        <div><h3>Checker at approval</h3>${checksHtml(ck, null, false)}</div></div></div>`);
  }

  // ---------------- Well report (a printable document per well) ----------------
  // Wells an answer is about: named in the answer text first, then wells the assistant looked up.
  function answerWells(res) {
    const known = new Set(D.snapshot.map(w => w.well_id)), out = [];
    for (const m of String(res.answer || '').matchAll(/\bW-\d{3}\b/g)) if (known.has(m[0]) && !out.includes(m[0])) out.push(m[0]);
    for (const t of res.trace || []) if (t.args && known.has(t.args.well_id) && !out.includes(t.args.well_id)) out.push(t.args.well_id);
    return out;
  }
  function reportCards(res) {
    const ws = answerWells(res); if (!ws.length) return '';
    const tok = Math.random().toString(36).slice(2, 10);
    const cited = new Set((res.sources || []).map(x => x.id)), ev = {};
    for (const id of cited) { const e = res.evidence[id] || chat.evidence[id]; if (e) ev[id] = Object.assign({}, e, {rows: (e.rows || []).slice(0, 200)}); }
    try { localStorage.setItem('ww-rep-' + tok, JSON.stringify({q: res._q, html: res._html, evidence: ev, eng: ENG, at: new Date().toISOString()}));
      Object.keys(localStorage).filter(k => k.startsWith('ww-rep-')).sort().slice(0, -30).forEach(k => localStorage.removeItem(k)); } catch (e) {}
    const shown = ws.slice(0, 3);
    return `<div class="repcards">${shown.map(id => { const w = D.snapshot.find(x => x.well_id === id);
      return `<a class="repcard" href="#report/${id}/${tok}" target="_blank" rel="noopener">${ic('file', 'md')}<span><b>Well report: ${id}</b> ${esc(w.well_name)}<br><span class="muted small">Flags, key numbers, tests, events, notes and sources. Opens in a new tab; print or save as PDF.</span></span>${ic('ext')}</a>`; }).join('')}
      ${ws.length > 3 ? `<div class="muted small">Also mentioned: ${ws.slice(3).map(id => `<a class="lk" href="#report/${id}/${tok}" target="_blank" rel="noopener">${id}</a>`).join(', ')}</div>` : ''}</div>`;
  }
  async function renderReport(id, tok) {
    const w = D.snapshot.find(x => x.well_id === id);
    document.body.classList.add('report-mode');
    if (!w) { $('#main').innerHTML = `<div class="errcard"><b>No well called ${esc(id)}.</b></div>`; return; }
    let ctx = null; try { ctx = tok ? JSON.parse(localStorage.getItem('ww-rep-' + tok) || 'null') : null; } catch (e) {}
    ENG = w.engineer_id; loadRules();
    if (ctx && ctx.evidence) chat.evidence = ctx.evidence;
    document.title = `${id} well report · Well Watch`;
    $('#main').innerHTML = `<div class="empty dots">Building the ${id} report</div>`;
    let d; try { d = await api('api/well/' + id); } catch (e) { $('#main').innerHTML = `<div class="errcard"><b>The report didn't load.</b><div>${esc(e.message)}</div><button class="btn" onclick="location.reload()">Retry</button></div>`; return; }
    const r = RANK.find(x => x.well_id === id), act = ACTIVE();
    const {kp, sk, fx, alertF, boxAlert, thr} = wellModel(id, w, r);
    const open = r ? r.flags.filter(f => !f.handled) : [], handled = r ? r.flags.filter(f => f.handled) : [];
    const tests = ITEMS.test.filter(t => t.well_id === id);
    const attn = tests.filter(t => t.overdue || ['Fail', 'Serious'].includes(t.last_result) || t.days_until_due <= 30).sort((a, b) => (testState(a) - testState(b)) || (a.days_until_due - b.days_until_due));
    const events = ITEMS.event.filter(e => e.well_id === id && (e.status !== 'Closed' || e.days_ago <= 30)).sort((a, b) => String(b.event_date).localeCompare(String(a.event_date)));
    const notes = D.notes.filter(n => n.well_id === id);
    const wos = d.work_orders.filter(o => !/^(closed|complete|completed|cancel)/i.test(String(o.status || '')));
    const down30 = d.downtime.filter(e => String(e.event_date) >= '2026-10-23');
    const sd = d.safety_daily, prod = d.daily.map(x => ({date: x.prod_date, y: x.reported ? x.oil_bbl : null, y2: x.target_oil_bopd}));
    const cands = [
      [['casing_pct_of_maasp', 'casing_psi_max_7d', 'casing_psi_change'], () => chartBox('Production casing vs MAASP (psi)', 'r_csgm', sd.map(x => ({date: x.reading_date, y: x.casing_psi, y2: x.prod_casing_maasp_psi})), {l1: 'Casing', l2: 'MAASP', kind: 'safety_daily', alert: true, thresh: thr('casing_pct_of_maasp', pct => w.prod_casing_maasp_psi * pct / 100)})],
      [['sc_psi_max_7d', 'sc_psi_change', 'sc_pct_of_limit'], () => chartBox('Surface casing vs limit (psi)', 'r_scp', sd.map(x => ({date: x.reading_date, y: x.sc_psi, y2: x.surface_casing_limit_psi})), {l1: 'Surface casing', l2: 'Limit', kind: 'safety_daily', alert: true, thresh: thr('sc_pct_of_limit', pct => w.surface_casing_limit_psi * pct / 100)})],
      [['flowline_pct_of_maop', 'flowline_psi_max_7d'], () => chartBox('Flowline max vs MAOP (psi)', 'r_flp', sd.map(x => ({date: x.reading_date, y: x.flowline_psi_max, y2: x.flowline_maop_psi})), {l1: 'Flowline', l2: 'MAOP', kind: 'safety_daily', alert: true, thresh: thr('flowline_pct_of_maop', pct => w.flowline_maop_psi * pct / 100)})],
      [['h2s_ambient_max_7d_ppm'], () => chartBox('H2S at surface, daily max (ppm)', 'r_h2s', sd.map(x => ({date: x.reading_date, y: x.h2s_ambient_ppm_max})), {kind: 'safety_daily', alert: true, thresh: thr('h2s_ambient_max_7d_ppm')})],
      [['water_cut_change_pts'], () => chartBox('Water cut (%)', 'r_wc', d.daily.map(x => ({date: x.prod_date, y: x.water_cut === null ? null : 100 * x.water_cut})), {alert: true})],
      [['gor_change_pct'], () => chartBox('Gas-oil ratio (scf/bbl)', 'r_gor', d.daily.map(x => ({date: x.prod_date, y: x.gor_scf_bbl})), {alert: true})]];
    const charts = [chartBox('Oil (bbl/d) vs type curve', 'r_oil', prod, {l1: 'Oil', l2: 'Type curve', alert: ['perf_ratio_7d', 'consecutive_down_days'].some(f => alertF.has(f))})]
      .concat(cands.filter(([fs]) => fs.some(f => alertF.has(f))).map(([, fn]) => fn())).slice(0, 4);
    const status = !r ? 'Not flagged by the current rules' : r.tier === 'handled' ? 'Every flag is being handled' : `Rank #${act.indexOf(r) + 1} of ${act.length} today · ${({safety: 'Safety', production: 'Production', watch: 'Watch list'})[r.tier]} tier`;
    const tiles = [['Today', status], ['Worst flag', r && open.length ? (r.safety_worst ? `${r.safety_worst} (safety)` : r.worst) : 'None'],
      ['Points', r ? `${r.safety_score ? r.safety_score + ' safety · ' : ''}${r.score} total` : '0'], ['At risk', `$${fmt(w.value_at_risk_cad_day)}/day`]];
    const kv = (rows) => `<table class="kv"><tbody>${rows.map(([l, v]) => `<tr class="${boxAlert(l) ? 'hit' : ''}"><th>${esc(l)}</th><td>${esc(v)}${boxAlert(l) ? ` <b class="flagtxt">${ic('flag')} flagged</b>` : ''}</td></tr>`).join('')}</tbody></table>`;
    const tbls = ['gold_well_snapshot', 'gold_v_well_safety', 'gold_daily_well', 'gold_safety_daily', 'gold_v_compliance_items', 'gold_v_safety_events', 'gold_downtime_events', 'silver_workorders', 'app_well_notes', 'app_flag_rules'];
    const tdesc = {gold_well_snapshot: 'production snapshot and ranking inputs', gold_v_well_safety: 'safety snapshot', gold_daily_well: 'daily production (charts)', gold_safety_daily: 'daily safety readings (charts)',
      gold_v_compliance_items: 'tests and inspections', gold_v_safety_events: 'safety events', gold_downtime_events: 'downtime', silver_workorders: 'work orders', app_well_notes: 'engineer notes', app_flag_rules: `${engName()}'s flag rules`};
    const now = new Date();
    $('#main').innerHTML = `<article class="report">
      <div class="rtools noprint"><button class="btn" id="rprint">${ic('file')} Print or save as PDF</button><a class="btn sec" href="./#day" target="_blank" rel="noopener">Open Well Watch</a></div>
      <header class="rhead"><div class="eyebrow">Well report <span class="pill warn" style="margin-left:6px">Synthetic data</span></div>
        <h1>${id} · ${esc(w.well_name)}</h1>
        <div class="muted">${esc(w.reservoir)} · ${esc(w.lift_type)} · ${esc(w.area)} · pad ${esc(w.pad)} · ${esc(w.sour_class)}</div>
        <div class="muted small">Engineer ${esc(w.engineer_name)} · data through ${esc(D.as_of)} · generated ${esc(now.toISOString().slice(0, 16).replace('T', ' '))} UTC · ranked with ${esc(engName())}'s ${rulesSource === 'saved' ? 'saved' : 'default'} rules</div></header>
      <div class="kpis" style="grid-template-columns:repeat(4,1fr)">${tiles.map(([l, v]) => `<div class="kpi"><div class="n" style="font-size:15px">${esc(v)}</div><div class="l">${l}</div></div>`).join('')}</div>
      ${ctx && ctx.q ? `<section><h2>Your question</h2><div class="rq">${esc(ctx.q)}</div><div class="ra">${ctx.html || ''}</div></section>` : ''}
      <section>${whyBox(r, fx, d, id, sk.filter(([l]) => !boxAlert(l)).map(([l]) => l))}</section>
      <section><h2>Flags (${open.length} open${handled.length ? `, ${handled.length} being handled` : ''})</h2>
        ${r && r.flags.length ? `<table><thead><tr><th>Severity</th><th>Flag</th><th>What was found</th><th>Next step</th><th class="n">Points</th></tr></thead><tbody>
          ${r.flags.map(f => `<tr style="${f.handled ? 'opacity:.6' : ''}"><td><span class="sev ${f.severity}">${f.severity}</span></td><td>${F.isSafety(f) ? SAFETY_TAG : ''}<b>${esc(f.rule_name)}</b>${f.handled ? `<div class="muted small">Being handled${f.handled.owner ? ' by ' + esc(f.handled.owner) : ''}${f.handled.until ? ' · follow up by ' + esc(String(f.handled.until).slice(0, 10)) : ''}</div>` : ''}</td>
            <td>${esc(f.message)}</td><td class="small">${esc(f.action || '')}</td><td class="n">${f.weight}${f.counted === false ? '<div class="muted small">counted once</div>' : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">No flags from the current rules.</div>'}</section>
      <section class="two"><div><h2>Safety numbers</h2>${kv(sk)}</div><div><h2>Production numbers</h2>${kv(kp)}</div></section>
      <section><h2>Trends since Aug 1</h2><div class="charts">${charts.join('')}</div></section>
      <section><h2>Tests and inspections needing attention (${attn.length})</h2>
        ${attn.length ? `<table><thead><tr><th>Status</th><th>Test</th><th>Last done</th><th>Result</th><th>Next due</th></tr></thead><tbody>${attn.map(t => `<tr><td>${testStatus(t)}</td><td>${esc(t.test_type)} ${t.safety_critical ? SC_LABEL : ''}</td><td>${esc(String(t.last_test_date).slice(0, 10))}</td><td>${esc(t.last_result)}</td><td>${esc(String(t.next_due_date).slice(0, 10))}</td></tr>`).join('')}</tbody></table>` : ''}
        <div class="muted small">${tests.length - attn.length} other test${tests.length - attn.length === 1 ? '' : 's'} up to date, from the maintenance / integrity system.</div></section>
      <section><h2>Safety events (open, or in the last 30 days): ${events.length}</h2>
        ${events.length ? `<table><thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Status</th><th>Regulator</th></tr></thead><tbody>${events.map(e => `<tr><td>${esc(String(e.event_date).slice(0, 10))}</td><td>${esc(e.category)}</td><td class="muted">${esc(e.description || '')}</td>
          <td>${e.status === 'Closed' ? 'Closed' : `<span class="pill crit">${ic('x')} Open</span>`}</td><td>${e.reportable ? (e.reported_to_regulator ? 'Reported' : `<span class="pill crit">${ic('x')} Not reported</span>`) : '<span class="muted small">Not flagged reportable in HSE system</span>'}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">None.</div>'}</section>
      <section><h2>Notes (${notes.length})</h2>${notes.length ? notes.map(n => noteHtml(n, false)).join('') : '<div class="muted">None.</div>'}</section>
      <section class="two"><div><h2>Open work orders (${wos.length})</h2>${wos.length ? `<table><tbody>${wos.map(o => `<tr><td>${esc(o.wo_number)}</td><td>${esc(o.wo_type)}: ${esc(o.description)}</td><td>${esc(o.status)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">None.</div>'}</div>
        <div><h2>Downtime, last 30 days (${down30.length})</h2>${down30.length ? `<table><tbody>${down30.map(e => `<tr><td>${esc(e.event_date)}</td><td>${esc(e.category)}</td><td class="n">${e.is_open ? '<span class="pill crit">open</span>' : fmt(e.hours_lost, 1) + ' h'}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">None.</div>'}</div></section>
      <section><h2>Sources</h2><div class="note">Every number in this report comes from these tables in Databricks (schema ${esc(SCH())}). Open a table to see all of its rows.</div>
        <ul class="rsrc">${tbls.map(t => `<li><a href="${esc(tableUrl(SCH() + '.' + t))}" target="_blank" rel="noopener"><code>${t}</code> ${ic('ext')}</a> <span class="muted">${esc(tdesc[t])}</span></li>`).join('')}</ul>
        ${ctx && ctx.evidence && Object.keys(ctx.evidence).length ? `<div class="note">The answer above cites ${Object.keys(ctx.evidence).map(k => `<span class="cite" data-ev="${k}">${k}</span>`).join(' ')}; click one to see its query and rows.</div>` : ''}</section>
      <footer class="muted small">Well Watch · synthetic data, not a real well · this report flags issues for review and does not make safety decisions; follow your company's procedures.</footer></article>`;
    $('#rprint').onclick = () => window.print();
    const theme = document.documentElement.dataset.theme;
    window.onbeforeprint = () => { document.documentElement.dataset.theme = 'light'; };
    window.onafterprint = () => { document.documentElement.dataset.theme = theme; };
    bindCommon($('#main')); bindCites(); bindCharts(id);
  }

  // ---------------- Chat ----------------
  function toggleChat(open) {
    const o = open === undefined ? $('#chat').hidden : open;
    $('#chat').hidden = !o; document.body.classList.toggle('chat-open', o); store.set('ww-chat', o ? 'open' : 'closed');
    if (o) $('#q').focus();
  }
  function newChat() {
    chat.id = null; chat.evidence = {};
    const ex = ['What should I look at first today?', 'Are there any safety issues on my wells?', 'Which of my tests and inspections are overdue?', RANK[0] ? `Why is ${RANK[0].well_id} ranked first?` : null,
      'Which production problems pay back fastest?'].filter(Boolean);
    $('#msgs').innerHTML = `<div class="muted small">Ask about ${esc(engName() || 'your')}'s wells: production, safety, tests, events. The assistant can only answer from the gold tables and your flag ranking. Every answer ends with its sources, linked to the tables in Databricks and traceable to the raw files. Facts carry [E1] chips, and each answer is checked: cited numbers must appear in the cited data. It does not make safety decisions.</div>
      <div class="sugg">${ex.map(q => `<button>${esc(q)}</button>`).join('')}</div>`;
    document.querySelectorAll('.sugg button').forEach(b => b.onclick = () => ask(b.textContent));
  }
  function ask(q) { toggleChat(true); $('#q').value = q; send(); }
  async function send() {
    const q = $('#q').value.trim(); if (!q || chat.busy) return;
    $('#q').value = ''; chat.busy = true; $('#send').disabled = true;
    const sug = $('#msgs .sugg'); if (sug) sug.remove();
    $('#msgs').insertAdjacentHTML('beforeend', `<div class="m u">${esc(q)}</div><div class="m a" id="pending"><span class="muted dots">Looking it up</span></div>`);
    scrollChat();
    const act = ACTIVE();
    const ranking = RANK.map(r => ({rank: r.tier === 'handled' ? null : act.indexOf(r) + 1, tier: r.tier, well_id: r.well_id, well_name: r.fact.well_name, points: r.score, worst_severity: r.worst, safety_flag: r.safety_worst || 'none',
      dollars_per_day_at_risk: r.value, fix_cost_cad: r.fix_cost, payback_days: r.payback_days,
      flags: r.flags.map(f => ({rule: f.rule_name, severity: f.severity, category: f.category, message: f.message, being_handled: f.handled ? (f.handled.note || 'yes') : false, back_because: f.resurfaced || null}))}));
    try {
      const res = await post('api/chat', {conversation_id: chat.id, message: q, engineer_id: ENG, engineer_name: engName(), ranking, rules: RULES, safety_first: true, ranking_mode: MODE, wo_handled: WO_HANDLED});
      chat.id = res.conversation_id; Object.assign(chat.evidence, res.evidence);
      res._q = q; $('#pending').outerHTML = `<div class="m a">${renderAnswer(res)}</div>`;
    } catch (e) { $('#pending').outerHTML = `<div class="m a"><span style="color:var(--dk-status-bad)">The assistant couldn't answer: ${esc(e.message)}. Try again in a moment.</span></div>`; }
    chat.busy = false; $('#send').disabled = false; bindCites(); scrollChat();
  }
  function scrollChat() { const m = $('#msgs'); m.scrollTop = m.scrollHeight; }
  function renderAnswer(res) {
    let html = esc(res.answer);
    for (const v of res.verification) {
      if (!['no_source', 'number_mismatch', 'unknown_citation'].includes(v.status)) continue;
      const s = esc(v.sentence); const tip = v.status === 'no_source' ? 'States a fact with no source' : v.status === 'unknown_citation' ? 'Cites evidence that does not exist' : 'Number(s) not found in the cited data: ' + v.unmatched_numbers.join(', ');
      html = html.replace(s, `<mark class="${v.status}" title="${esc(tip)}">${s}</mark>`);
    }
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    html = html.replace(/\[(E\d+(?:,\s*E\d+)*)\]/g, (m, g) => g.split(/,\s*/).map(id => `<span class="cite" data-ev="${id}" title="${esc(res.evidence[id]?.title || 'unknown evidence')}">${id}</span>`).join(''));
    const lines = html.split('\n').filter(l => l.trim()); let out = '', inList = false;
    for (const l of lines) { const b = /^\s*[-*•]\s+(.*)/.exec(l);
      if (b) { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${b[1]}</li>`; } else { if (inList) { out += '</ul>'; inList = false; } out += `<p>${l}</p>`; } }
    if (inList) out += '</ul>';
    const s = res.summary, bad = s.no_source + s.number_mismatch + s.unknown_citation;
    if (s.unsourced) return out + sourcesHtml(res);
    out += s.statements ? `<div class="verdict ${bad ? 'bad' : 'ok'}">${bad ? `${ic('alert')} <span>${s.ok} of ${s.statements} factual statements verified. Highlighted text could not be matched to the cited data; check it before relying on it.</span>`
      : `${ic('check')} <span>All ${s.statements} factual statement${s.statements > 1 ? 's' : ''} verified against the cited data.</span>`}</div>` : '';
    res._html = out; out += sourcesHtml(res) + reportCards(res);
    if (res.trace.length) out += `<div class="trace">Looked up: ${res.trace.map(t => `${esc(t.tool.replace(/_/g, ' '))}${t.args.well_id ? ' ' + esc(t.args.well_id) : ''}${t.evidence_id ? `, <span class="cite" data-ev="${t.evidence_id}">${t.evidence_id}</span>` : t.error ? ' (error)' : ''}`).join(' · ')}</div>`;
    return out;
  }
  // Every answer ends with the sources the app actually queried (built by the app, not written by the model).
  const SCH = () => (D && D.schema) || 'workspace.well_ops';
  const LANDING = () => '/Volumes/' + SCH().replace('.', '/') + '/landing';
  const tableUrl = t => /^[\w]+\.[\w]+\.[\w]+$/.test(t) ? `${D.workspace_url}/explore/data/${t.split('.').join('/')}` : null;
  function sourcesHtml(res) {
    const src = res.sources || [];
    if (!src.length) return `<div class="verdict none">${ic('alert')} <span>No data was looked up for this answer, so it has no source. Don't rely on it; try rephrasing the question.</span></div>`;
    return `<div class="srcs"><b>Sources (${src.length})</b>${src.map(s => { const e = res.evidence[s.id] || chat.evidence[s.id]; if (!e) return '';
      const tabs = (e.tables || [e.table]).map(t => { const u = tableUrl(t); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t.split('.').pop())} ${ic('ext')}</a>` : esc(t); }).join(', ');
      return `<div class="src"><span class="cite" data-ev="${s.id}">${s.id}</span> ${esc(e.title)}${s.cited ? '' : ' <span class="muted">(checked, not cited)</span>'}
        <div class="muted">${esc(e.row_count)} row${e.row_count === 1 ? '' : 's'} from ${tabs} · <a class="lk" data-ev2="${s.id}">view rows and trace to raw file</a></div></div>`; }).join('')}</div>`;
  }
  function bindCites() {
    document.querySelectorAll('[data-ev2]').forEach(c => c.onclick = () => showEvidence(c.dataset.ev2)); document.querySelectorAll('.cite').forEach(c => c.onclick = () => showEvidence(c.dataset.ev)); }
  function showEvidence(id) {
    const e = chat.evidence[id];
    if (!e) { showModal(`<div class="mhead"><h2>${esc(id)}</h2><button class="btn sec close" id="mx">Close</button></div><div class="mbody"><div class="empty">The assistant cited evidence that doesn't exist. Treat that statement as unsupported.</div></div>`); return; }
    const layer = e.layer.startsWith('gold') ? 'gold' : e.layer;
    const traceFn = r => {
      if (r.prod_date && r.well_id) return {kind: 'daily', well_id: r.well_id, date: String(r.prod_date).slice(0, 10)};
      if (r.record_id) return {kind: 'test', bronze_id: r.record_id};
      if (r.event_id) return {kind: 'safety_event', bronze_id: r.event_id};
      if (r._bronze_id && r.wo_number) return {kind: 'work_order', bronze_id: r._bronze_id};
      if (r._bronze_id && e.table.includes('downtime')) return {kind: 'downtime', bronze_id: r._bronze_id};
      if (r.month && r.well_id) return {kind: 'economics', well_id: r.well_id, month: String(r.month).slice(0, 10)};
      if (r.well_id && e.tool === 'get_safety_status') return {kind: 'safety_snapshot', well_id: r.well_id};
      if (r.well_id && e.tool !== 'portfolio_summary') return {kind: 'snapshot', well_id: r.well_id};
      return null;
    };
    showModal(`<div class="mhead"><span class="cite" style="font-size:13px">${esc(id)}</span><h2>${esc(e.title)}</h2><button class="btn sec close" id="mx">Close</button></div>
      <div class="mbody"><div><span class="layer ${layer}">${esc(e.layer)}</span> ${(e.tables || [e.table]).map(t => tableUrl(t) ? `<a class="small" href="${esc(tableUrl(t))}" target="_blank" rel="noopener"><code>${esc(t)}</code> ${ic('ext')}</a>` : `<code class="small">${esc(t)}</code>`).join(' ')} · <span class="muted small">tool: ${esc(e.tool)} · ${e.row_count} row${e.row_count === 1 ? '' : 's'}</span></div>
        <h3>Query the assistant ran</h3><pre class="sql">${esc(e.sql)}</pre>
        ${e.summary ? `<h3>Summary computed by the tool (not by the model)</h3>${rowsTable([e.summary])}` : ''}
        <h3>Rows returned <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· "trace" follows a row back to silver, bronze and the raw file</span></h3>
        ${rowsTable(e.rows.map(r => { const o = Object.assign({}, r); if (o.flags) o.flags = o.flags.map(f => f.rule).join('; '); return o; }), {traceFn, focus: (() => { const ws = [...new Set(e.rows.map(r => r.well_id).filter(Boolean))]; return ws.length === 1 ? buildFocus(ws[0]) : null; })()})}</div>`);
    document.querySelectorAll('#mbox [data-lin]').forEach(a => a.onclick = () => lineage(JSON.parse(a.dataset.lin)));
  }

  init();
})();
