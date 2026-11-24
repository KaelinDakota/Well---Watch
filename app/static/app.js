/* Well Watch UI. Ranking is computed here with FlagEngine (deterministic, no AI) from the gold snapshot, the safety view,
   tests/inspections and safety events. Engineers can log tests and events, update event status and define their own per-well
   fields, so a rule can track any safety measure. The assistant answers through /api/chat; every fact links to evidence,
   and every gold row can be traced to silver, bronze and the raw file through /api/lineage. */
(function () {
  const F = window.FlagEngine;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const clone = o => JSON.parse(JSON.stringify(o));
  const fmt = (v, d = 0) => v === null || v === undefined || v === '' || isNaN(Number(v)) ? '–' : Number(v).toLocaleString('en-US', {minimumFractionDigits: d, maximumFractionDigits: d});
  const store = {get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} }};
  const api = async (path, opts) => { const r = await fetch(path, opts); if (!r.ok) throw new Error((await r.text()).slice(0, 300) || r.statusText); return r.json(); };
  const post = (path, body, method = 'POST') => api(path, {method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const lin = o => `data-lin='${esc(JSON.stringify(o))}'`;

  let D = null, ENG = null, RULES = [], MODE = 'value', SAFETY_FIRST = true, WO_HANDLED = false, ACKS = {}, EST = {}, RANK = [], ITEMS = {test: [], event: []}, view = 'day', rulesSource = 'default', showAll = false;
  let wellSort = {k: 'score', dir: -1}, wellFilter = '', ruleFilter = 'All';
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
    D.attrs = attrs; ITEMS = D.items; D.settings = D.settings || {}; D.acks = D.acks || []; D.estimates = D.estimates || [];
  }
  async function init() {
    try { await loadBundle(); } catch (e) { $('#main').innerHTML = `<div class="empty">Could not load data: ${esc(e.message)}</div>`; return; }
    $('#asof').textContent = D.as_of;
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
  function render() {
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
  // Test status: red only when something is wrong. "Safety-critical" is a neutral label about the test's importance, not its result.
  const SC_LABEL = '<span class="sclabel" title="A test that must not be missed or failed. Says nothing about the result.">Safety-critical</span>';
  const testState = t => ['Fail', 'Serious'].includes(t.last_result) ? 0 : t.overdue ? 1 : t.days_until_due <= 30 ? 2 : t.last_result === 'Non-serious' ? 3 : 4;
  const testStatus = t => ({0: `<span class="pill crit">✗ ${t.last_result === 'Serious' ? 'Serious result' : 'Failed'}</span>`, 1: `<span class="pill crit">${t.days_overdue} d overdue</span>`,
    2: `<span class="pill warn">Due in ${t.days_until_due} d</span>`, 3: '<span class="pill warn">OK · monitor</span>', 4: '<span class="pill ok">✓ OK</span>'})[testState(t)];
  const TEST_LEGEND = '<div class="note" style="margin:-4px 0 6px"><span class="sclabel">Safety-critical</span> means the test must not be missed or failed. It says nothing about the result. The Status column shows how the well is doing: <span class="pill ok">✓ OK</span> <span class="pill warn">due soon</span> <span class="pill crit">overdue or failed</span></div>';

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
      ${fx.notes.map(f => `<div style="margin-top:4px"><span class="sev ${f.severity}" style="display:inline-block;margin-right:6px">${f.severity}</span>${f.safety ? '<span class="shield">SAFETY</span>' : ''}<b>${esc(f.rule_name)}</b> · ${esc(f.message)}${f.handled ? ' <span class="muted">(being handled)</span>' : ''}</div>`).join('')}
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
        <div class="kpi"><div class="n">${mine.length}</div><div class="l">wells assigned to ${esc(engName())}</div></div>
        <div class="kpi crit"><div class="n">${saf}</div><div class="l">wells with a safety issue</div></div>
        <div class="kpi warn"><div class="n">${prod.length}</div><div class="l">wells losing production or money</div></div>
        <div class="kpi"><div class="n">$${fmt(var_)}</div><div class="l">per day at risk on those wells</div></div>
        <div class="kpi"><div class="n">${handled.length}</div><div class="l">marked as being handled</div></div>
        <div class="kpi"><div class="n">${fmt(oil)}</div><div class="l">bbl/d oil, last 7 days (type curve ${fmt(tgt)})</div></div></div>
      <div class="bar"><b style="font-size:16px">${showAll ? 'Everything that needs attention' : 'Top 10 to look at today'}</b>
        <span class="note">${SAFETY_FIRST ? 'Safety first, then production and cost by ' + SORT_LABEL() : 'Ranked by ' + SORT_LABEL()}, then the watch list · related rules count once · <a class="lk" id="torules">change rules</a></span>
        ${act.length > 10 ? `<button class="btn sec small" id="more" style="margin-left:auto">${showAll ? 'Show top 10' : `Show all ${act.length}`}</button>` : ''}</div>
      <div class="card">${list.length ? list.map((r, i) => { const t = r.tier !== last ? `<div class="tier">${head[r.tier][0]} <span style="text-transform:none;letter-spacing:0;font-weight:400;color:var(--muted)">· ${head[r.tier][1]}</span></div>` : ''; last = r.tier; return t + wellCard(r, i + 1); }).join('')
        : '<div class="empty">Nothing needs attention under your current rules.</div>'}</div>
      ${!showAll && act.length > 10 ? `<div class="note" style="margin-top:8px">${act.length - 10} more below the top 10: ${act.slice(10).map(r => `<a class="lk" data-well="${r.well_id}">${r.well_id}</a>`).join(', ')}</div>` : ''}
      ${handled.length ? `<h3>Being handled (${handled.length}) <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· off the list until the date passes, or sooner if the problem gets worse</span></h3>
        <div class="card">${handled.map(r => `<div class="wcard"><div class="rk">–</div><div><div class="t"><a data-well="${r.well_id}">${r.well_id} · ${esc(r.fact.well_name)}</a></div></div><div></div>${r.flags.map(flagHtml).join('')}</div>`).join('')}</div>` : ''}`;
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
    const acts = h ? (h.type === 'ack' ? `<a class="lk" data-unack='${key}'>no longer being handled</a>` : '')
      : `<a class="lk" data-ack='${key}'>mark as being handled</a>${!f.safety ? ` · <a class="lk" data-est='${key}'>${EST[f.well_id + '|' + f.rule_id] !== undefined ? 'change' : 'add'} fix cost estimate</a>` : ''}`;
    return `<div class="flag" style="${h ? 'opacity:.6' : ''}"><span class="sev ${f.severity}">${f.severity}</span><div class="msg">${F.isSafety(f) ? '<span class="shield">SAFETY</span>' : ''}${f.resurfaced ? '<span class="shield" style="background:#c9822b">BACK</span>' : ''}<b>${esc(f.rule_name)}</b> · ${esc(f.message)}</div>
      ${f.resurfaced ? `<div class="act" style="color:#8a5a10">Back on the list: ${esc(f.resurfaced)}.</div>` : ''}
      ${h ? `<div class="act"><b>Being handled</b>${h.type === 'ack' ? ` until ${esc(String(h.until).slice(0, 10))} by ${esc(h.by || '')}` : ' (open work order)'}${h.note ? ` · ${esc(h.note)}` : ''}</div>` : ''}
      <div class="chips">${chips}</div>${f.action && !h ? `<div class="act">Next step: ${esc(f.action)}</div>` : ''}
      <div class="act small">${meta.join(' · ')}${meta.length ? ' · ' : ''}${acts}</div></div>`;
  }
  function wellCard(r, n) {
    const w = r.fact;
    const side = r.tier === 'production'
      ? `<div class="score">$${fmt(r.value)}/day</div><div class="val">${r.value_parts.operating_loss ? `$${fmt(r.value_parts.lost_oil)} lost oil + $${fmt(r.value_parts.operating_loss)} operating loss` : 'lost oil vs type curve'}</div>
         <div class="val">${r.fix_cost ? `fix ≈ $${fmt(r.fix_cost)}${r.payback_days ? ` · pays back in ~${fmt(r.payback_days)} days` : ''}` : 'no fix cost estimate'}</div><div class="val">${r.score} pts</div>`
      : r.tier === 'safety' ? `<div class="score" style="color:var(--crit)">${r.safety_worst}</div><div class="val">${r.safety_score} safety pts · ${r.score} total</div>`
      : `<div class="score">${r.score} pts</div>`;
    return `<div class="wcard"><div class="rk">${n}</div>
      <div><div class="t"><a data-well="${w.well_id}">${w.well_id} · ${esc(w.well_name)}</a></div>
        <div class="meta">${esc(w.reservoir)} · ${esc(w.lift_type)} · ${esc(w.area)} · ${esc(w.sour_class || '')} · ${fmt(w.oil_7d_bopd, 1)} bbl/d vs ${fmt(w.target_7d_bopd, 1)} type curve${Number(w.open_work_orders) > 0 ? ` · open work order: ${esc(w.open_work_order)}` : ''}</div></div>
      <div class="side">${side}</div>
      ${r.flags.map(flagHtml).join('')}
      <div class="wactions"><button class="btn sec small" data-well="${w.well_id}">Open well</button><button class="btn sec small" data-ask="${w.well_id}">Ask why</button>
        <button class="btn sec small" data-trace-snap="${w.well_id}" data-cat="${esc(r.flags[0].category)}">Trace these numbers</button></div></div>`;
  }
  function bindFlagActions(root) {
    const find = k => { const {w, r} = JSON.parse(k); const rr = RANK.find(x => x.well_id === w); return {rk: rr, f: rr && rr.flags.find(f => f.rule_id === r), rule: RULES.find(x => x.id === r)}; };
    root.querySelectorAll('[data-ack]').forEach(a => a.onclick = e => { e.stopPropagation(); ackForm(find(a.dataset.ack)); });
    root.querySelectorAll('[data-unack]').forEach(a => a.onclick = async e => { e.stopPropagation(); const {f} = find(a.dataset.unack);
      await post('api/acks', {engineer_id: ENG, well_id: f.well_id, rule_id: f.rule_id, cleared: true}); await refresh('Back on the list'); });
    root.querySelectorAll('[data-est]').forEach(a => a.onclick = e => { e.stopPropagation(); estForm(find(a.dataset.est)); });
  }
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  function ackForm({rk, f, rule}) {
    const wo = Number(rk.fact.open_work_orders) > 0 ? rk.fact.open_work_order : '';
    formModal(`Mark as being handled: ${f.rule_name} on ${f.well_id}`, `<div class="note">It leaves the list until the date below. It comes back sooner if it gets worse${f.items ? ' (a new matching record appears)' : ' (a condition moves more than 10% further past its threshold)'}.${f.safety ? ' <b>Safety flag: a note on who is handling it and how is required.</b>' : ''}</div>
      <div class="frm"><div><label>Until</label><input id="a-until" type="date" min="${D.today}" max="${addDays(D.today, 30)}" value="${addDays(D.today, 7)}"></div><div></div>
      <div class="full"><label>Note${f.safety ? ' (required)' : ''}</label><textarea id="a-note" placeholder="e.g. Pump change booked for Nov 26, Rig 4">${esc(wo ? 'Open work order ' + wo : '')}</textarea></div></div>`, async () => {
        if (f.safety && !val('a-note').trim()) throw new Error('Add a note on who is handling it and how.');
        await post('api/acks', {engineer_id: ENG, well_id: f.well_id, rule_id: f.rule_id, until_date: val('a-until'), note: val('a-note'), safety: !!f.safety, snapshot: F.ackSnapshot(f, rule, rk.fact)});
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
    const sc = Object.fromEntries(RANK.map(r => [r.well_id, {score: r.score, rank: act.indexOf(r) + 1 || '–', worst: r.worst, n: r.flags.length, safety: r.safety_worst, tier: r.tier}]));
    const cols = [['well_id', 'Well'], ['score', 'Score', 1], ['perf_ratio_7d', 'vs type curve', 1], ['oil_7d_bopd', 'Oil bbl/d', 1], ['water_cut_7d_pct', 'Water cut %', 1],
      ['casing_pct_of_maasp', 'Casing % MAASP', 1], ['sc_psi_max_7d', 'Surf. csg psi', 1], ['h2s_ambient_max_7d_ppm', 'H2S ppm', 1], ['tests_overdue', 'Tests overdue', 1],
      ['open_safety_events', 'Open events', 1], ['uptime_14d_pct', 'Uptime %', 1], ['value_at_risk_cad_day', 'At risk $/d', 1]];
    let rows = myWells().map(w => Object.assign({}, w, {score: sc[w.well_id]?.score || 0, _f: sc[w.well_id]}));
    if (wellFilter) { const q = wellFilter.toLowerCase(); rows = rows.filter(w => [w.well_id, w.well_name, w.reservoir, w.lift_type, w.area, w.sour_class].join(' ').toLowerCase().includes(q)); }
    rows.sort((a, b) => { const x = a[wellSort.k], y = b[wellSort.k]; return (x === y ? 0 : x === null ? 1 : y === null ? -1 : x > y ? 1 : -1) * wellSort.dir; });
    $('#main').innerHTML = `<div class="bar"><input id="wf" placeholder="Filter by well, reservoir, lift, area, sour class" value="${esc(wellFilter)}" style="width:320px"><span class="note">${rows.length} wells · click a column to sort · click a well to open it</span></div>
      <div class="card" style="overflow:auto"><table><thead><tr>${cols.map(([k, l, n]) => `<th class="s ${n ? 'n' : ''}" data-k="${k}">${l}${wellSort.k === k ? (wellSort.dir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('')}<th>Flags</th></tr></thead>
      <tbody>${rows.map(w => `<tr class="click" data-well="${w.well_id}"><td><b>${w.well_id}</b> ${esc(w.well_name)}<div class="muted small">${esc(w.reservoir)} · ${esc(w.lift_type)} · ${esc(w.sour_class)}</div></td>
        <td class="n">${w._f ? `<b>${w.score}</b> <span class="muted small">#${w._f.rank}</span>` : '<span class="muted">0</span>'}</td>
        <td class="n">${fmt(w.perf_ratio_7d, 2)}×</td><td class="n">${fmt(w.oil_7d_bopd, 1)}</td><td class="n">${fmt(w.water_cut_7d_pct, 1)}</td>
        <td class="n">${fmt(w.casing_pct_of_maasp, 0)}%</td><td class="n">${fmt(w.sc_psi_max_7d, 0)}</td><td class="n">${fmt(w.h2s_ambient_max_7d_ppm)}</td><td class="n">${fmt(w.tests_overdue)}</td>
        <td class="n">${fmt(w.open_safety_events)}</td><td class="n">${fmt(w.uptime_14d_pct, 1)}</td><td class="n">${fmt(w.value_at_risk_cad_day)}</td>
        <td>${w._f && w._f.tier === 'handled' ? '<span class="pill">being handled</span>' : w._f ? `${w._f.safety && w._f.safety !== 'Review' ? '<span class="shield">SAFETY</span>' : ''}<span class="pill ${w._f.worst === 'Critical' ? 'crit' : w._f.worst === 'Warning' ? 'warn' : 'rev'}">${w._f.n} flag${w._f.n > 1 ? 's' : ''}</span>` : '<span class="pill ok">OK</span>'}</td></tr>`).join('')}</tbody></table></div>`;
    $('#wf').oninput = e => { wellFilter = e.target.value; const pos = e.target.selectionStart; renderWells(); $('#wf').focus(); $('#wf').setSelectionRange(pos, pos); };
    document.querySelectorAll('th.s').forEach(th => th.onclick = () => { const k = th.dataset.k; wellSort = {k, dir: wellSort.k === k ? -wellSort.dir : (k === 'well_id' ? 1 : -1)}; renderWells(); });
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
      <td style="white-space:nowrap"><a class="lk" ${lin(itemLin(t))}>trace</a> · <a class="lk" data-logtest='${esc(JSON.stringify({well_id: t.well_id, test_type: t.test_type, test_group: t.test_group, interval_months: t.interval_months, safety_critical: t.safety_critical}))}'>log result</a></td></tr>`;
    const evRow = e => `<tr><td>${esc(String(e.event_date).slice(0, 10))}</td><td><a class="lk" data-well="${e.well_id}">${e.well_id}</a></td><td><b>${esc(e.category)}</b><div class="muted small">${esc(e.description || '')}</div></td>
      <td>${e.reportable ? (e.reported_to_regulator ? '<span class="pill ok">reported</span>' : '<span class="pill crit">NOT reported</span>') : '<span class="muted small">not reportable</span>'}</td>
      <td style="white-space:nowrap"><a class="lk" ${lin(itemLin(e))}>trace</a>${e.status !== 'Closed' ? ` · <a class="lk" data-evupd="${e.event_id}">update</a>` : ''}</td></tr>`;
    const tblT = (head, rows, empty) => rows.length ? TEST_LEGEND.replace('margin:-4px 0 6px', 'margin:6px 12px') + tbl(head, rows, empty) : tbl(head, rows, empty);
    const tbl = (head, rows, empty) => rows.length ? `<div class="tw" style="max-height:320px;border:0"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<div class="muted small" style="padding:10px 12px">${empty}</div>`;
    $('#main').innerHTML = `<div class="bar"><button class="btn" id="btest">+ Log a test or inspection</button><button class="btn" id="bevent">+ Log a safety event</button>
        <button class="btn sec" id="bfields">Custom fields (${D.custom_fields.length})</button>
        <span class="note">Anything not in the data feeds can be logged here or added as a custom field, then tracked with a rule on the Flag rules tab.</span></div>
      <div class="kpis six">
        <div class="kpi crit"><div class="n">${safeWells.filter(r => r.safety_worst === 'Critical').length}</div><div class="l">wells with a critical safety flag</div></div>
        <div class="kpi crit"><div class="n">${overdue.filter(t => t.safety_critical).length}</div><div class="l">safety-critical tests overdue</div></div>
        <div class="kpi warn"><div class="n">${overdue.length}</div><div class="l">tests / inspections overdue</div></div>
        <div class="kpi"><div class="n">${soon.length}</div><div class="l">due in the next 30 days</div></div>
        <div class="kpi crit"><div class="n">${open.length}</div><div class="l">open safety events</div></div>
        <div class="kpi crit"><div class="n">${events.filter(e => e.reportable && !e.reported_to_regulator).length}</div><div class="l">reportable, not yet reported</div></div></div>
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
    $('#btest').onclick = () => testForm({}); $('#bevent').onclick = () => eventForm({}); $('#bfields').onclick = fieldsManager;
    document.querySelectorAll('[data-logtest]').forEach(a => a.onclick = () => testForm(JSON.parse(a.dataset.logtest)));
    document.querySelectorAll('[data-evupd]').forEach(a => a.onclick = () => eventUpdate(a.dataset.evupd));
    bindCommon($('#main'));
  }
  const wellOptions = sel => myWells().map(w => `<option value="${w.well_id}" ${w.well_id === sel ? 'selected' : ''}>${w.well_id} · ${esc(w.well_name)}</option>`).join('');
  function formModal(title, body, onSave) {
    showModal(`<div class="mhead"><h2>${esc(title)}</h2><button class="btn sec close" id="mx">Cancel</button></div><div class="mbody">${body}
      <div class="errs" id="ferr"></div><div style="margin-top:14px"><button class="btn" id="fsave">Save</button></div></div>`);
    $('#fsave').onclick = async () => { $('#fsave').disabled = true; try { await onSave(); } catch (e) { $('#ferr').textContent = e.message; $('#fsave').disabled = false; } };
  }
  const val = id => ($('#' + id) || {}).value;
  function testForm(p) {
    const cat = D.test_catalog;
    formModal('Log a test or inspection', `<div class="frm">
      <div><label>Well</label><select id="t-w">${wellOptions(p.well_id)}</select></div>
      <div><label>Test / inspection type <span class="muted" style="font-weight:400">· pick one or type a new one</span></label><input id="t-type" list="t-types" value="${esc(p.test_type || '')}" placeholder="e.g. Subsurface safety valve test"><datalist id="t-types">${cat.map(c => `<option value="${esc(c.test_type)}">`).join('')}</datalist></div>
      <div><label>Group</label><input id="t-grp" value="${esc(p.test_group || '')}" placeholder="Integrity, Pressure safety, Detection..."></div>
      <div><label>Required every (months)</label><input id="t-int" value="${esc(p.interval_months || '')}"></div>
      <div><label>Safety-critical</label><select id="t-crit"><option value="true" ${p.safety_critical ? 'selected' : ''}>Yes</option><option value="false" ${p.safety_critical === false ? 'selected' : ''}>No</option></select></div>
      <div><label>Test date</label><input id="t-date" type="date" value="${D.as_of}"></div>
      <div><label>Result</label><select id="t-res">${['Pass', 'Fail', 'Non-serious', 'Serious'].map(x => `<option>${x}</option>`).join('')}</select></div>
      <div><label>Measured value (optional)</label><input id="t-val" placeholder="e.g. 12"></div>
      <div><label>Unit</label><input id="t-unit" placeholder="e.g. m3/d, % wall loss, psi"></div>
      <div class="full"><label>Notes</label><textarea id="t-notes"></textarea></div></div>`, async () => {
        await post('api/tests', {well_id: val('t-w'), test_type: val('t-type'), test_group: val('t-grp'), interval_months: val('t-int'), safety_critical: val('t-crit') === 'true',
          test_date: val('t-date'), result_status: val('t-res'), result_value: val('t-val'), result_unit: val('t-unit'), notes: val('t-notes')});
        $('#modal').hidden = true; await refresh('Test logged');
      });
    $('#t-type').onchange = () => { const c = cat.find(x => x.test_type === val('t-type')); if (c) { $('#t-grp').value = c.test_group; $('#t-int').value = c.interval_months; $('#t-crit').value = String(c.safety_critical); } };
  }
  function eventForm(p) {
    const cats = ['ESD trip', 'PSV lift', 'H2S alarm', 'Gas detector alarm', 'Spill', 'Gas release', 'Flowline failure', 'Fire', 'Electrical fault', 'Regulator non-compliance', 'Near miss'];
    formModal('Log a safety event', `<div class="frm">
      <div><label>Well</label><select id="e-w">${wellOptions(p.well_id)}</select></div>
      <div><label>Category <span class="muted" style="font-weight:400">· pick one or type a new one</span></label><input id="e-cat" list="e-cats" placeholder="e.g. Spill"><datalist id="e-cats">${cats.map(c => `<option value="${c}">`).join('')}</datalist></div>
      <div><label>Date</label><input id="e-date" type="date" value="${D.as_of}"></div>
      <div><label>Status</label><select id="e-st"><option>Open</option><option>Closed</option></select></div>
      <div><label>Planned activity</label><select id="e-pl"><option value="false">No</option><option value="true">Yes (e.g. function test)</option></select></div>
      <div><label>Volume (m3, optional)</label><input id="e-vol"></div>
      <div><label>Substance</label><input id="e-sub" placeholder="Produced water, emulsion, gas..."></div>
      <div><label>Reportable to regulator</label><select id="e-rep"><option value="false">No</option><option value="true">Yes</option></select></div>
      <div><label>Reported to regulator</label><select id="e-rtd"><option value="false">Not yet</option><option value="true">Yes</option></select></div>
      <div class="full"><label>Description</label><textarea id="e-desc"></textarea></div></div>`, async () => {
        await post('api/events', {well_id: val('e-w'), category: val('e-cat'), event_date: val('e-date'), status: val('e-st'), planned: val('e-pl') === 'true', volume_m3: val('e-vol'),
          substance: val('e-sub'), reportable: val('e-rep') === 'true', reported_to_regulator: val('e-rtd') === 'true', description: val('e-desc')});
        $('#modal').hidden = true; await refresh('Event logged');
      });
  }
  function eventUpdate(id) {
    const e = ITEMS.event.find(x => x.event_id === id);
    formModal(`Update ${e.category} on ${e.well_id}`, `<div class="note">${esc(String(e.event_date).slice(0, 10))} · ${esc(e.description || '')}</div><div class="frm">
      <div><label>Status</label><select id="u-st"><option ${e.status !== 'Closed' ? 'selected' : ''}>Open</option><option>Closed</option></select></div>
      <div><label>Reported to regulator</label><select id="u-r"><option value="">${e.reportable ? 'no change' : 'not reportable'}</option><option value="true" ${e.reported_to_regulator ? 'selected' : ''}>Yes</option><option value="false">Not yet</option></select></div>
      <div class="full"><label>Note</label><textarea id="u-n" placeholder="e.g. Cleanup complete, sampling passed; regulator ref #..."></textarea></div></div>`, async () => {
        await post(`api/events/${id}/update`, {status: val('u-st'), reported_to_regulator: val('u-r') === '' ? null : val('u-r') === 'true', note: val('u-n')});
        $('#modal').hidden = true; await refresh('Event updated');
      });
  }
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
      return c.field_type === 'yesno' ? `<select data-w="${w.well_id}"><option value="" ${v === '' ? 'selected' : ''}>–</option><option value="true" ${v === 'true' ? 'selected' : ''}>Yes</option><option value="false" ${v === 'false' ? 'selected' : ''}>No</option></select>`
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
    const sk = [['Casing vs MAASP', `${fmt(w.casing_psi_max_7d)} / ${fmt(w.prod_casing_maasp_psi)} psi (${fmt(w.casing_pct_of_maasp, 0)}%)`], ['Surface casing', `${fmt(w.sc_psi_max_7d, 0)} / ${fmt(w.surface_casing_limit_psi)} psi (${fmt(w.sc_pct_of_limit, 0)}%)`],
      ['Flowline vs MAOP', `${fmt(w.flowline_psi_max_7d, 0)} / ${fmt(w.flowline_maop_psi)} psi (${fmt(w.flowline_pct_of_maop, 0)}%)`], ['Vent flow test', `${w.scvf_status || '–'}${w.scvf_rate_m3d ? ' · ' + fmt(w.scvf_rate_m3d) + ' m3/d' : ''}`],
      ['H2S', `${fmt(w.h2s_ppm_gas)} ppm in gas · ${fmt(w.h2s_ambient_max_7d_ppm)} ppm at surface`], ['EPZ', w.epz_m ? `${fmt(w.epz_m)} m · ${fmt(w.residences_in_epz)} residences` : 'none (sweet)'],
      ['Venting this month', `${fmt(w.vent_mtd_m3)} / ${fmt(w.vent_limit_m3_month)} m3 (${fmt(w.vent_pct_of_limit, 0)}%)`], ['Tests', `${fmt(w.tests_overdue)} overdue · ${fmt(w.tests_due_30d)} due ≤30 d · ${fmt(w.failed_tests)} failed`]];
    const sd = d.safety_daily, prod = d.daily.map(x => ({date: x.prod_date, y: x.reported ? x.oil_bbl : null, y2: x.target_oil_bopd}));
    const myTests = ITEMS.test.filter(t => t.well_id === id).sort((a, b) => (testState(a) - testState(b)) || (a.days_until_due - b.days_until_due));
    const myEvents = ITEMS.event.filter(e => e.well_id === id).sort((a, b) => String(b.event_date).localeCompare(String(a.event_date)));
    $('#dbody').innerHTML = `
      <h3>Flags today ${r ? (r.tier === 'handled' ? '· all being handled' : `· ${r.tier} · rank #${ACTIVE().indexOf(r) + 1} · ${r.score} pts${r.tier === 'production' ? ` · $${fmt(r.value)}/day` : ''}`) : ''}</h3>
      ${r ? `<div style="display:grid;grid-template-columns:44px 1fr auto">${r.flags.map(flagHtml).join('')}</div>` : '<div class="muted">No flags from your rules.</div>'}
      <h3>Safety <a class="lk small" ${lin({kind: 'safety_snapshot', well_id: id})} style="text-transform:none;letter-spacing:0;margin-left:6px">trace →</a></h3>
      <div class="kpis" style="grid-template-columns:repeat(4,1fr)">${sk.map(([l, v]) => `<div class="kpi"><div class="n" style="font-size:14px">${esc(v)}</div><div class="l">${l}</div></div>`).join('')}</div>
      <div class="charts">
        ${chartBox('Production casing vs MAASP (psi)', 'csgm', sd.map(x => ({date: x.reading_date, y: x.casing_psi, y2: x.prod_casing_maasp_psi})), {l1: 'Casing', l2: 'MAASP', kind: 'safety_daily'})}
        ${chartBox('Surface casing vs limit (psi)', 'scp', sd.map(x => ({date: x.reading_date, y: x.sc_psi, y2: x.surface_casing_limit_psi})), {l1: 'Surface casing', l2: 'Limit', kind: 'safety_daily'})}
        ${chartBox('Flowline max vs MAOP (psi)', 'flp', sd.map(x => ({date: x.reading_date, y: x.flowline_psi_max, y2: x.flowline_maop_psi})), {l1: 'Flowline', l2: 'MAOP', kind: 'safety_daily'})}
        ${chartBox('H2S at surface, daily max (ppm)', 'h2s', sd.map(x => ({date: x.reading_date, y: x.h2s_ambient_ppm_max})), {kind: 'safety_daily'})}
      </div>
      <h3>Tests and inspections (${myTests.length}) <a class="lk" id="dlogt" style="text-transform:none;letter-spacing:0;margin-left:6px">+ log one</a></h3>
      ${myTests.length ? TEST_LEGEND + `<div class="tw" style="max-height:280px"><table><thead><tr><th>Status</th><th>Test</th><th>Last done</th><th>Result</th><th>Next due</th><th>Recorded in</th><th></th></tr></thead><tbody>
        ${myTests.map(t => `<tr><td>${testStatus(t)}</td><td>${esc(t.test_type)} ${t.safety_critical ? SC_LABEL : ''}</td><td>${esc(String(t.last_test_date).slice(0, 10))}</td>
          <td>${esc(t.last_result)}${t.result_value !== null && t.result_value !== undefined ? ` · ${esc(t.result_value)} ${esc(t.result_unit || '')}` : ''}</td>
          <td>${esc(String(t.next_due_date).slice(0, 10))}</td>
          <td class="muted small">${esc(t.source)}</td><td><a class="lk" ${lin(itemLin(t))}>trace</a></td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">None.</div>'}
      <h3>Safety events (${myEvents.length}) <a class="lk" id="dloge" style="text-transform:none;letter-spacing:0;margin-left:6px">+ log one</a></h3>
      ${myEvents.length ? `<div class="tw" style="max-height:240px"><table><thead><tr><th>Date</th><th>Category (AI)</th><th>As typed</th><th>Status</th><th>Regulator</th><th></th></tr></thead><tbody>
        ${myEvents.map(e => `<tr><td>${esc(String(e.event_date).slice(0, 10))}</td><td>${esc(e.category)}${e.planned ? ' <span class="muted small">(planned)</span>' : ''}</td><td class="muted">${esc(e.event_type_original)}: ${esc(e.description || '')}</td>
          <td>${e.status === 'Closed' ? 'Closed' : '<span class="pill crit">Open</span>'}</td><td>${e.reportable ? (e.reported_to_regulator ? 'reported' : '<b style="color:var(--crit)">not reported</b>') : '–'}</td>
          <td style="white-space:nowrap"><a class="lk" ${lin(itemLin(e))}>trace</a>${e.status !== 'Closed' ? ` · <a class="lk" data-evupd="${e.event_id}">update</a>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">None.</div>'}
      ${D.custom_fields.length ? `<h3>Custom fields <a class="lk" id="dcf" style="text-transform:none;letter-spacing:0;margin-left:6px">edit</a></h3><div class="kpis" style="grid-template-columns:repeat(4,1fr)">
        ${D.custom_fields.map(c => `<div class="kpi"><div class="n" style="font-size:14px">${esc(F.fmtVal('x_' + c.field_key, w['x_' + c.field_key]))}</div><div class="l">${esc(c.label)}</div></div>`).join('')}</div>` : ''}
      <h3>Production snapshot as of ${D.as_of} <a class="lk small" ${lin({kind: 'snapshot', well_id: id})} style="text-transform:none;letter-spacing:0;margin-left:6px">trace →</a></h3>
      <div class="kpis" style="grid-template-columns:repeat(4,1fr)">${kp.map(([l, v]) => `<div class="kpi"><div class="n" style="font-size:16px">${esc(v)}</div><div class="l">${l}</div></div>`).join('')}</div>
      <h3>Daily data since Aug 1 <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· click any point to trace it back to the raw file</span></h3>
      <div class="charts">
        ${chartBox('Oil (bbl/d) vs type curve', 'oil', prod, {l1: 'Oil', l2: 'Type curve'})}
        ${chartBox('Water cut (%)', 'wc', d.daily.map(x => ({date: x.prod_date, y: x.water_cut === null ? null : 100 * x.water_cut})))}
        ${chartBox('Gas-oil ratio (scf/bbl)', 'gor', d.daily.map(x => ({date: x.prod_date, y: x.gor_scf_bbl})))}
        ${chartBox('Production casing pressure (psi)', 'csg', d.daily.map(x => ({date: x.prod_date, y: x.casing_psi})))}
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
    $('#dlogt').onclick = () => testForm({well_id: id}); $('#dloge').onclick = () => eventForm({well_id: id});
    document.querySelectorAll('#dbody [data-evupd]').forEach(a => a.onclick = () => eventUpdate(a.dataset.evupd));
    if ($('#dcf')) $('#dcf').onclick = () => editWellFields(id);
    bindCharts(id);
  }
  function editWellFields(id) {
    formModal(`Custom fields for ${id}`, `<div class="frm">${D.custom_fields.map(c => { const v = (D.attrs[id] || {})[c.field_key] ?? '';
      return `<div><label>${esc(c.label)}</label>${c.field_type === 'yesno' ? `<select data-k="${c.field_key}"><option value="">–</option><option value="true" ${v === 'true' ? 'selected' : ''}>Yes</option><option value="false" ${v === 'false' ? 'selected' : ''}>No</option></select>`
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
    const ys = pts.flatMap(p => [p.y, p.y2]).filter(v => v !== null && v !== undefined);
    if (!ys.length) return `<div class="chart"><div class="ct">${title}</div><div class="muted small">No data.</div></div>`;
    let lo = Math.min(...ys), hi = Math.max(...ys); if (lo === hi) { lo -= 1; hi += 1; } const pad = (hi - lo) * 0.08; lo = Math.max(lo - pad, Math.min(...ys) >= 0 ? 0 : lo - pad); hi += pad;
    const x = i => L + (W - L - R) * i / Math.max(1, pts.length - 1), y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const path = k => { let s = '', pen = false; pts.forEach((p, i) => { const v = p[k]; if (v === null || v === undefined) { pen = false; return; } s += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); pen = true; }); return s; };
    const ticks = [lo, (lo + hi) / 2, hi].map(v => `<text x="${L - 4}" y="${y(v) + 3}" text-anchor="end" font-size="9" fill="#5d6b78">${fmt(v, hi - lo < 5 ? 1 : 0)}</text><line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#eef1f3"/>`).join('');
    const months = pts.map((p, i) => [String(p.date), i]).filter(([d]) => d.slice(8, 10) === '01').map(([d, i]) => `<text x="${x(i)}" y="${H - 6}" font-size="9" fill="#5d6b78" text-anchor="middle">${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+d.slice(5, 7) - 1]}</text>`).join('');
    const limit = o.l2 && ['MAASP', 'Limit', 'MAOP'].includes(o.l2);
    return `<div class="chart"><div class="ct">${title}</div>${o.l1 ? `<div class="lg"><span style="color:#2f6fb3">━</span> ${o.l1} &nbsp; <span style="color:${limit ? '#c2412d' : '#b38a12'}">┅</span> ${o.l2}</div>` : ''}
      <svg viewBox="0 0 ${W} ${H}" data-chart="${key}" data-l="${L}" data-r="${R}" data-w="${W}">${ticks}${months}
        ${pts.some(p => p.y2 !== undefined) ? `<path d="${path('y2')}" fill="none" stroke="${limit ? '#c2412d' : '#b38a12'}" stroke-width="1.5" stroke-dasharray="4 3"/>` : ''}
        <path d="${path('y')}" fill="none" stroke="#2f6fb3" stroke-width="1.6"/>
        <line class="hair" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="#9aa6b1" visibility="hidden"/>
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
    $('#mbox .mbody').innerHTML = focusBanner(fx) + `<div class="note" style="margin:4px 0 12px">${esc(sub)} · gold (what the app and the assistant read) → silver (cleaned) → bronze (as received) → raw file</div>` +
      d.steps.map(s => `<div class="step"><div><span class="layer ${s.layer}">${s.layer}</span> ${tableUrl(s.table) ? `<a class="small" href="${esc(tableUrl(s.table))}" target="_blank" rel="noopener"><code>${esc(s.table)}</code> ↗</a>` : s.layer === 'raw' ? `<a class="small" href="${esc(D.workspace_url + '/explore/data/volumes/workspace/well_ops/landing')}" target="_blank" rel="noopener"><code>/Volumes/workspace/well_ops/landing</code> ↗</a>` : `<code class="small">${esc(s.table)}</code>`}</div>
        ${s.note ? `<div class="note" style="margin:3px 0">${esc(s.note)}</div>` : ''}
        ${(s.rules || []).length ? `<div class="rulebox"><b>Cleaning rules applied:</b>${[...new Map(s.rules.map(r => [r.rule_id, r])).values()].map(r => `<div><code>${esc(r.rule_id)}</code> ${esc(r.description)}</div>`).join('')}</div>` : ''}
        ${s.files ? `<div class="rulebox">${s.files.map(f => `📄 ${esc(f)}`).join('<br>')}</div>` : ''}
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
      return `<div class="tw" style="max-height:300px"><table><tbody>${cols.map(c => `<tr><th style="position:static" class="${fc(c) ? 'fcol' : ''}">${esc(c)}</th><td class="${cls(c, r0[c])}">${cell(r0[c])}${hitCell(fc(c), r0[c]) ? ' ⚑' : ''}</td></tr>`).join('')}</tbody></table></div>`;
    }
    if (fx) {  // flagged columns move next to the identifying columns so they're visible without scrolling
      const key = c => /^(well_id|uwi_alias|prod_date|reading_date|event_date|event_ts|test_date|month|test_id|event_id|record_id|entry_id|test_type|category)$/i.test(c);
      cols = cols.filter(key).concat(cols.filter(c => !key(c) && fc(c)), cols.filter(c => !key(c) && !fc(c)));
    }
    const shown = rows.slice(0, 120);
    const rowHit = r => isItem(r) || cols.some(c => hitCell(fc(c), r[c]));
    const nHit = fx ? shown.filter(rowHit).length : 0;
    return `${nHit ? `<div class="small" style="color:#8a1c0f;margin:4px 0">⚑ ${nHit} of ${shown.length} row${shown.length === 1 ? '' : 's'} crossed a flag threshold or belong to the flag (marked below).</div>` : ''}
      <div class="tw"><table><thead><tr>${o.traceFn ? '<th></th>' : ''}${cols.map(c => `<th class="${fc(c) ? 'fcol' : ''}">${esc(c)}</th>`).join('')}</tr></thead><tbody>
      ${shown.map(r => { const t = o.traceFn ? o.traceFn(r) : null, h = fx && rowHit(r);
        return `<tr class="${r._used_in_silver ? 'used' : ''} ${h ? 'frow' : ''}">${o.traceFn ? `<td>${h ? '⚑ ' : ''}${t ? `<a class="lk" ${lin(t)}>trace</a>` : ''}</td>` : ''}${cols.map(c => `<td class="${cls(c, r[c])}">${cell(r[c])}</td>`).join('')}</tr>`; }).join('')}</tbody></table></div>
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
        <div><div><span class="sev ${esc(r.severity)}" style="display:inline-block;margin-right:8px">${esc(r.severity)}</span>${F.isSafety(r) ? '<span class="shield">SAFETY</span>' : ''}<b>${esc(r.name)}</b> <span class="muted small">${esc(r.category || '')}</span><span class="ds">${esc(F.DATASETS[ds].label)}</span></div>
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
        <table><tbody>${F.DEFAULT_RULES.map(d => { const inUse = RULES.some(r => r.id === d.id); return `<tr><td>${F.isSafety(d) ? '<span class="shield">SAFETY</span>' : ''}<b>${esc(d.name)}</b><span class="ds">${esc(F.DATASETS[d.dataset || 'well'].label)}</span>
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
  function toast(t) { const el = document.createElement('div'); el.className = 'toast'; el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 3500); }

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
            <button class="btn danger c-del" title="Remove condition">✕</button></div>
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
    } catch (e) { $('#pending').outerHTML = `<div class="m a"><span style="color:var(--crit)">Error: ${esc(e.message)}</span></div>`; }
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
    out += s.statements ? `<div class="verdict ${bad ? 'bad' : 'ok'}">${bad ? `⚠ ${s.ok} of ${s.statements} factual statements verified. Highlighted text could not be matched to the cited data; check it before relying on it.`
      : `✓ All ${s.statements} factual statement${s.statements > 1 ? 's' : ''} verified against the cited data.`}</div>` : '';
    out += sourcesHtml(res);
    if (res.trace.length) out += `<div class="trace">Looked up: ${res.trace.map(t => `${esc(t.tool.replace(/_/g, ' '))}${t.args.well_id ? ' ' + esc(t.args.well_id) : ''}${t.evidence_id ? ` → <span class="cite" data-ev="${t.evidence_id}">${t.evidence_id}</span>` : t.error ? ' (error)' : ''}`).join(' · ')}</div>`;
    return out;
  }
  // Every answer ends with the sources the app actually queried (built by the app, not written by the model).
  const tableUrl = t => /^[\w]+\.[\w]+\.[\w]+$/.test(t) ? `${D.workspace_url}/explore/data/${t.split('.').join('/')}` : null;
  function sourcesHtml(res) {
    const src = res.sources || [];
    if (!src.length) return `<div class="verdict bad" style="background:#fde3df;color:var(--crit)">⚠ No data was looked up for this answer, so it has no source. Don't rely on it; try rephrasing the question.</div>`;
    return `<div class="srcs"><b>Sources (${src.length})</b>${src.map(s => { const e = res.evidence[s.id] || chat.evidence[s.id]; if (!e) return '';
      const tabs = (e.tables || [e.table]).map(t => { const u = tableUrl(t); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t.split('.').pop())} ↗</a>` : esc(t); }).join(', ');
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
      <div class="mbody"><div><span class="layer ${layer}">${esc(e.layer)}</span> ${(e.tables || [e.table]).map(t => tableUrl(t) ? `<a class="small" href="${esc(tableUrl(t))}" target="_blank" rel="noopener"><code>${esc(t)}</code> ↗</a>` : `<code class="small">${esc(t)}</code>`).join(' ')} · <span class="muted small">tool: ${esc(e.tool)} · ${e.row_count} row${e.row_count === 1 ? '' : 's'}</span></div>
        <h3>Query the assistant ran</h3><pre class="sql">${esc(e.sql)}</pre>
        ${e.summary ? `<h3>Summary computed by the tool (not by the model)</h3>${rowsTable([e.summary])}` : ''}
        <h3>Rows returned <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· "trace" follows a row back to silver, bronze and the raw file</span></h3>
        ${rowsTable(e.rows.map(r => { const o = Object.assign({}, r); if (o.flags) o.flags = o.flags.map(f => f.rule).join('; '); return o; }), {traceFn, focus: (() => { const ws = [...new Set(e.rows.map(r => r.well_id).filter(Boolean))]; return ws.length === 1 ? buildFocus(ws[0]) : null; })()})}</div>`);
    document.querySelectorAll('#mbox [data-lin]').forEach(a => a.onclick = () => lineage(JSON.parse(a.dataset.lin)));
  }

  init();
})();
