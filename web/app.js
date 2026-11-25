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
    D.attrs = attrs; ITEMS = D.items; D.settings = D.settings || {}; D.acks = D.acks || []; D.estimates = D.estimates || []; D.notes = D.notes || [];
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
    loadRules(); newChat();
    const h = (location.hash || '').slice(1); if (['day', 'wells', 'safety', 'rules'].includes(h)) view = h;
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
    } else { RULES = clone(F.DEFAULT_RULES); MODE = 'value'; rulesSource = 'default'; }
    const st = D.settings[ENG] || {};
    SAFETY_FIRST = st.safety_first === undefined || st.safety_first === null ? true : !!st.safety_first;
    WO_HANDLED = !!st.wo_handled;
    recompute();
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
    const titles = {day: 'My day', wells: 'My wells', safety: 'Safety', rules: 'Flag rules'};
    $('#ptitle').textContent = titles[view];
    $('#pmeta').innerHTML = `${esc(engName() || '')}<span class="sep" style="opacity:.5;padding:0 6px">·</span>${myWells().length} wells<span class="sep" style="opacity:.5;padding:0 6px">·</span>Data through ${esc(D.as_of)}`;
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === view));
    const ids = myIds();
    $('#c-day').textContent = Math.min(10, ACTIVE().length); $('#c-wells').textContent = ids.size; $('#c-rules').textContent = RULES.filter(r => r.enabled).length;
    $('#c-safety').textContent = RANK.filter(r => r.tier === 'safety').length;
    ({day: renderDay, wells: renderWells, safety: renderSafety, rules: renderRules})[view]();
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
    const h = f.handled, meta = [];
    if (!h) meta.push(`${f.weight} pts${f.counted === false ? ` <span class="muted">(not added: counted once with "${esc(f.counted_with)}")</span>` : ''}`);
    if (!h && f.fix_cost !== null && f.fix_cost !== undefined) meta.push(`fix ≈ $${fmt(f.fix_cost)} <span class="muted">(${esc(f.fix_cost_source)})</span>`);
    const acts = (h ? (h.type === 'ack' ? `<a class="lk" data-unack='${key}'>no longer being handled</a>` : '')
      : `<a class="lk" data-ack='${key}'>mark as being handled</a>${!f.safety ? ` · <a class="lk" data-est='${key}'>${EST[f.well_id + '|' + f.rule_id] !== undefined ? 'change' : 'add'} fix cost estimate</a>` : ''}`) + ` · <a class="lk" data-note='${key}'>add note</a>`;
    const fnotes = D.notes.filter(n => n.well_id === f.well_id && n.rule_id === f.rule_id);
    return `<div class="flag" style="${h ? 'opacity:.6' : ''}"><span class="sev ${f.severity}">${f.severity}</span><div class="msg">${F.isSafety(f) ? SAFETY_TAG : ''}${f.resurfaced ? `<span class="shield back">${ic('undo')}Back on the list</span>` : ''}<b>${esc(f.rule_name)}</b> · ${esc(f.message)}</div>
      ${f.resurfaced ? `<div class="act" style="color:var(--dk-status-amber)">Back on the list: ${esc(f.resurfaced)}.</div>` : ''}
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
    root.querySelectorAll('[data-note]').forEach(a => a.onclick = e => { e.stopPropagation(); const {w, r} = JSON.parse(a.dataset.note); noteForm({well_id: w, rule_id: r}); });
  }
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  function ackForm({rk, f, rule}) {
    const wo = Number(rk.fact.open_work_orders) > 0 ? rk.fact.open_work_order : '';
    formModal(`Mark as being handled: ${f.rule_name} on ${f.well_id}`, `<div class="note">It leaves the list until the follow-up date. It comes back sooner if it gets worse${f.items ? ' (a new matching record appears)' : ' (a condition moves more than 10% further past its threshold)'}.${f.safety ? ' <b>Safety flag: a note on who is handling it and how is required.</b>' : ''}</div>
      <div class="frm"><div><label>Who is handling it</label><input id="a-owner" list="a-owners" placeholder="e.g. Field ops (North), Integrity team"><datalist id="a-owners">${['Field ops', 'Production engineer', 'Integrity team', 'HSE', 'Maintenance', 'Service rig contractor', 'Electrician'].map(o => `<option value="${o}">`).join('')}</datalist></div>
      <div><label>Follow up by</label><input id="a-until" type="date" min="${D.today}" max="${addDays(D.today, 30)}" value="${addDays(D.today, 7)}"></div>
      <div class="full"><label>Note${f.safety ? ' (required)' : ''}</label><textarea id="a-note" placeholder="e.g. Pump change booked for Nov 26, Rig 4">${esc(wo ? 'Open work order ' + wo : '')}</textarea></div></div>`, async () => {
        if (f.safety && !val('a-note').trim()) throw new Error('Add a note on who is handling it and how.');
        if (!val('a-owner').trim()) throw new Error('Say who is handling it.');
        await post('api/acks', {engineer_id: ENG, well_id: f.well_id, rule_id: f.rule_id, until_date: val('a-until'), note: val('a-note'), owner: val('a-owner'), safety: !!f.safety, snapshot: F.ackSnapshot(f, rule, rk.fact)});
        $('#modal').hidden = true; await refresh('Marked as being handled');
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
      <td>${e.reportable ? (e.reported_to_regulator ? `<span class="pill ok">${ic('check')} Reported</span>` : `<span class="pill crit">${ic('x')} Not reported</span>`) : '<span class="muted small">Not reportable</span>'}</td>
      <td style="white-space:nowrap"><a class="lk" ${lin(itemLin(e))}>trace</a></td></tr>`;
    const tblT = (head, rows, empty) => rows.length ? TEST_LEGEND.replace('margin:-4px 0 6px', 'margin:6px 12px') + tbl(head, rows, empty) : tbl(head, rows, empty);
    const tbl = (head, rows, empty) => rows.length ? `<div class="tw" style="max-height:320px;border:0"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<div class="muted small" style="padding:10px 12px">${empty}</div>`;
    $('#main').innerHTML = `<div class="bar"><span class="note" style="max-width:900px">Tests come from the <b>maintenance / integrity system</b> and incidents from the <b>HSE incident system</b>, recorded by field and safety staff. This tab is read-only: to correct a record, fix it in that system. To add context, write a <b>note</b> on the well; for a value the systems don't carry, add a <b>custom field</b>.</span>
        <button class="btn sec" id="bfields" style="margin-left:auto">Custom fields (${D.custom_fields.length})</button></div>
      <div class="kpis six">
        <div class="kpi crit"><div class="n">${safeWells.filter(r => r.safety_worst === 'Critical').length}</div><div class="l">Wells with a critical safety flag</div></div>
        <div class="kpi crit"><div class="n">${overdue.filter(t => t.safety_critical).length}</div><div class="l">Safety-critical tests overdue</div></div>
        <div class="kpi warn"><div class="n">${overdue.length}</div><div class="l">Tests and inspections overdue</div></div>
        <div class="kpi"><div class="n">${soon.length}</div><div class="l">Due in the next 30 days</div></div>
        <div class="kpi crit"><div class="n">${open.length}</div><div class="l">Open safety events</div></div>
        <div class="kpi crit"><div class="n">${events.filter(e => e.reportable && !e.reported_to_regulator).length}</div><div class="l">Reportable, not yet reported</div></div></div>
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
    const sd = d.safety_daily, prod = d.daily.map(x => ({date: x.prod_date, y: x.reported ? x.oil_bbl : null, y2: x.target_oil_bopd}));
    const myTests = ITEMS.test.filter(t => t.well_id === id).sort((a, b) => (testState(a) - testState(b)) || (a.days_until_due - b.days_until_due));
    const myNotes = D.notes.filter(n => n.well_id === id);
    const myEvents = ITEMS.event.filter(e => e.well_id === id).sort((a, b) => String(b.event_date).localeCompare(String(a.event_date)));
    // rule threshold drawn on each safety chart (red when it's why the well is flagged)
    const thr = (field, toUnits) => { const rl = RULES.find(x => x.enabled && (x.dataset || 'well') === 'well' && x.conditions.some(c => c.field === field && ['gt', 'gte'].includes(c.op)));
      if (!rl) return null; const c = rl.conditions.find(c => c.field === field && ['gt', 'gte'].includes(c.op)); const v = toUnits ? toUnits(Number(c.value)) : Number(c.value);
      return isFinite(v) ? {v, label: `${rl.name}: flag at ${c.op === 'gte' ? '≥' : '>'} ${fmt(c.value, 0)}${toUnits ? '%' : ''}`, on: alertF.has(field)} : null; };
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
      d.steps.map(s => `<div class="step"><div><span class="layer ${s.layer}">${s.layer}</span> ${tableUrl(s.table) ? `<a class="small" href="${esc(tableUrl(s.table))}" target="_blank" rel="noopener"><code>${esc(s.table)}</code> ${ic('ext')}</a>` : s.layer === 'raw' ? `<a class="small" href="${esc(D.workspace_url + '/explore/data/volumes/workspace/well_ops/landing')}" target="_blank" rel="noopener"><code>/Volumes/workspace/well_ops/landing</code> ${ic('ext')}</a>` : `<code class="small">${esc(s.table)}</code>`}</div>
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
      <div class="bar"><label class="note" style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="sf" ${SAFETY_FIRST ? 'checked' : ''}> Safety first (safety issues above everything else)</label>
        <label class="note" style="display:flex;gap:6px;align-items:center;cursor:pointer;margin-left:14px"><input type="checkbox" id="woh" ${WO_HANDLED ? 'checked' : ''}> Treat wells with an open work order as being handled (production flags only)</label></div>
      <div class="note" style="margin-bottom:8px">These are ${esc(engName())}'s rules${rulesSource === 'saved' ? ` (saved ${esc(String(D.saved_rules[ENG]?.saved_at || 'this session').slice(0, 16))})` : ' (defaults; not yet saved)'}. Wells are listed in tiers: ${SAFETY_FIRST ? 'safety first, then ' : ''}production and cost problems by ${SORT_LABEL()}, then a watch list. Points (the sum of rule weights, with rules in the same group counted once) break ties. Rules can look at well readings, at each test or inspection, or at each safety event. No AI decides a flag.</div>
      <div class="bar"><div class="filt">${cats.map(c => `<button data-cat="${esc(c)}" class="${ruleFilter === c ? 'on' : ''}">${esc(c)} ${c === 'All' ? RULES.length : RULES.filter(r => (r.category || 'Other') === c).length}</button>`).join('')}</div></div>
      <div class="card">${shown.map(([r, i]) => { const ds = r.dataset || 'well'; return `<div class="rule ${r.enabled ? '' : 'off'}">
        <button class="switch ${r.enabled ? 'on' : ''}" data-i="${i}" title="${r.enabled ? 'Turn off' : 'Turn on'}"></button>
        <div><div><span class="sev ${esc(r.severity)}" style="display:inline-block;margin-right:8px">${esc(r.severity)}</span>${F.isSafety(r) ? SAFETY_TAG : ''}<b>${esc(r.name)}</b> <span class="muted small">${esc(r.category || '')}</span><span class="ds">${esc(F.DATASETS[ds].label)}</span></div>
          <div class="cond" style="margin-top:4px">${ds === 'well' ? 'When' : `When at least <b>${r.min_count || 1}</b> ${ds === 'test' ? 'test(s)' : 'event(s)'} have`} ${r.match === 'any' ? '<b>any</b>' : '<b>all</b>'} of: ${r.conditions.map(cn => condText(cn, ds)).join(' · ')}</div>
          <div class="muted small" style="margin-top:2px">Flags ${counts[r.id] || 0} of your wells now${r.group ? ` · group: ${esc(r.group)} (counted once)` : ''}${r.fix_cost ? ` · typical fix ≈ $${fmt(r.fix_cost)}` : ''}</div></div>
        <div style="display:flex;gap:10px;align-items:start"><div class="wt">${r.weight}<small>points</small></div><button class="btn sec small" data-edit="${i}">Edit</button><button class="btn sec small" data-dup="${i}">Copy</button></div></div>`; }).join('')}</div>`;
    document.querySelectorAll('.switch').forEach(b => b.onclick = async () => { const r = RULES[+b.dataset.i]; r.enabled = !r.enabled; await persist(`${r.name} turned ${r.enabled ? 'on' : 'off'}`); });
    document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editRule(+b.dataset.edit));
    document.querySelectorAll('[data-dup]').forEach(b => b.onclick = () => { const cp = clone(RULES[+b.dataset.dup]); cp.id = 'CUSTOM_' + Date.now(); cp.name += ' (copy)'; editRule(null, cp); });
    document.querySelectorAll('[data-m]').forEach(b => b.onclick = async () => { MODE = b.dataset.m; await persist('Production problems ranked by ' + SORT_LABEL()); });
    $('#woh').onchange = async e => { WO_HANDLED = e.target.checked; await persist(WO_HANDLED ? 'Open work orders count as being handled' : 'Open work orders no longer hide flags'); };
    document.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { ruleFilter = b.dataset.cat; renderRules(); });
    $('#sf').onchange = async e => { SAFETY_FIRST = e.target.checked; await persist(SAFETY_FIRST ? 'Safety flags rank first' : 'Safety flags ranked by score like the rest'); };
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
      D.saved_rules[ENG] = {rules: clone(RULES), mode: MODE, saved_by: r.saved_by, saved_at: new Date().toISOString().replace('T', ' ')}; D.settings[ENG] = {safety_first: SAFETY_FIRST, wo_handled: WO_HANDLED}; rulesSource = 'saved'; toast(msg + ' · saved'); render();
    } catch (e) { toast('Could not save: ' + e.message); }
  }
  function toast(t) { const el = document.createElement('div'); el.className = 'toast' + (/^Could not|failed/i.test(t) ? ' err' : ''); el.setAttribute('role', 'status'); el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 3500); }

  function editRule(i, preset) {
    const isNew = i === null;
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
        <div style="display:flex;gap:8px;margin-top:14px"><button class="btn" id="e-save">Save rule</button>${isNew ? '' : '<button class="btn danger" id="e-delrule">Delete rule</button>'}</div></div>`;
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
      $('#e-save').onclick = async () => { sync(); const errs = F.validateRule(r); if (errs.length) { $('#e-err').textContent = errs.join(' '); return; }
        if (isNew) RULES.push(r); else RULES[i] = r; $('#editor').hidden = true; await persist(`Rule "${r.name}" saved`); };
      if (!isNew) $('#e-delrule').onclick = async () => { const name = RULES[i].name; RULES.splice(i, 1); $('#editor').hidden = true; await persist(`Rule "${name}" deleted`); };
      preview();
    };
    draw(); $('#editor').hidden = false;
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
      const res = await post('api/chat', {conversation_id: chat.id, message: q, engineer_id: ENG, engineer_name: engName(), ranking, rules: RULES, safety_first: SAFETY_FIRST, ranking_mode: MODE, wo_handled: WO_HANDLED});
      chat.id = res.conversation_id; Object.assign(chat.evidence, res.evidence);
      $('#pending').outerHTML = `<div class="m a">${renderAnswer(res)}</div>`;
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
    out += sourcesHtml(res);
    if (res.trace.length) out += `<div class="trace">Looked up: ${res.trace.map(t => `${esc(t.tool.replace(/_/g, ' '))}${t.args.well_id ? ' ' + esc(t.args.well_id) : ''}${t.evidence_id ? `, <span class="cite" data-ev="${t.evidence_id}">${t.evidence_id}</span>` : t.error ? ' (error)' : ''}`).join(' · ')}</div>`;
    return out;
  }
  // Every answer ends with the sources the app actually queried (built by the app, not written by the model).
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
