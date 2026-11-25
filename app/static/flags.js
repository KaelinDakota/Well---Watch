/* Well Watch flag + ranking engine. Rules are plain JSON so engineers can create and edit them. Evaluation is deterministic: no AI.
   A rule runs on one data set:
     well  - one row per well (production, safety readings vs limits, compliance and event summaries, engineer-defined custom fields)
     test  - every test / inspection type per well (latest record), from the compliance system or logged in the app
     event - every safety event (ESD trips, PSV lifts, alarms, spills, releases, regulator findings...), from the field log or the app
   For test and event rules, a well is flagged when at least `min_count` of its items match the conditions. */
(function (root) {
  const F = (field, label, type, help, group) => ({field, label, type, help, group});
  const WELL_FIELDS = [
    // production
    F('well_name', 'Well name', 'text', 'Well name', 'Well'), F('reservoir', 'Reservoir', 'text', 'Producing reservoir', 'Well'),
    F('lift_type', 'Lift type', 'text', 'ESP, rod pump or gas lift', 'Well'), F('area', 'Area', 'text', 'Operating area', 'Well'),
    F('oil_7d_bopd', 'Oil, last 7 days (bbl/d)', 'number', 'Average daily oil over the last 7 reported days', 'Production'),
    F('target_7d_bopd', 'Type-curve target (bbl/d)', 'number', 'Average type-curve rate over the last 7 days', 'Production'),
    F('perf_ratio_7d', 'Performance vs type curve (last 7 d)', 'number', 'Oil / type curve on producing hours. 1.0 = on curve', 'Production'),
    F('perf_ratio_baseline', 'Performance vs type curve (baseline)', 'number', 'Same ratio for Oct 10 - Nov 8', 'Production'),
    F('water_cut_7d_pct', 'Water cut, last 7 days (%)', 'number', 'Water / total liquid', 'Production'),
    F('water_cut_change_pts', 'Water cut change (points)', 'number', 'Last 7 days minus baseline, in percentage points', 'Production'),
    F('gor_7d', 'Gas-oil ratio, last 7 days (scf/bbl)', 'number', 'Gas per barrel of oil', 'Production'),
    F('gor_change_pct', 'Gas-oil ratio change (%)', 'number', 'Last 7 days vs baseline', 'Production'),
    F('casing_psi_7d', 'Casing pressure, last 7 days (psi)', 'number', 'Average production casing pressure', 'Production'),
    F('casing_psi_change', 'Casing pressure change (psi)', 'number', 'Last 7 days minus baseline', 'Production'),
    F('uptime_14d_pct', 'Uptime, last 14 days (%)', 'number', 'Producing hours / available hours', 'Production'),
    F('downtime_events_14d', 'Unplanned downtime events (14 d)', 'number', 'Count of unplanned events in the last 14 days', 'Production'),
    F('consecutive_down_days', 'Days down (consecutive)', 'number', 'Consecutive reported days with zero hours on', 'Production'),
    F('open_event_planned', 'Current outage is planned', 'boolean', 'The open downtime event is planned (turnaround, workover)', 'Production'),
    F('open_event_category', 'Current outage category', 'text', 'Category of the open downtime event', 'Production'),
    F('days_since_last_data', 'Days since last SCADA data', 'number', '0 = data arrived for yesterday', 'Production'),
    F('days_since_workover', 'Days since last workover', 'number', 'Empty if no recent workover', 'Production'),
    F('open_work_orders', 'Open work orders', 'number', 'Work orders not yet closed', 'Production'),
    F('margin_per_boe', 'Operating margin ($/boe, Oct)', 'number', 'Netback minus operating cost per boe', 'Economics'),
    F('loe_per_boe', 'Operating cost ($/boe, Oct)', 'number', 'Lease operating expense per boe', 'Economics'),
    F('lost_oil_bopd', 'Oil below type curve (bbl/d)', 'number', 'Type-curve rate minus actual, last 7 days', 'Economics'),
    F('value_at_risk_cad_day', 'Value at risk ($/day)', 'number', 'Lost oil x oil netback per bbl', 'Economics'),
    // safety: integrity
    F('prod_casing_maasp_psi', 'Production casing MAASP (psi)', 'number', 'Maximum allowable annular surface pressure for the production casing', 'Safety · integrity'),
    F('casing_psi_max_7d', 'Production casing pressure, max 7 d (psi)', 'number', 'Highest daily casing pressure in the last 7 days', 'Safety · integrity'),
    F('casing_pct_of_maasp', 'Casing pressure as % of MAASP', 'number', 'Max casing pressure (7 d) / MAASP x 100', 'Safety · integrity'),
    F('wellhead_rating_psi', 'Wellhead pressure rating (psi)', 'number', 'Working pressure rating of the wellhead', 'Safety · integrity'),
    F('sc_psi_max_7d', 'Surface casing pressure, max 7 d (psi)', 'number', 'Surface casing (vent) annulus pressure. Normally near 0', 'Safety · integrity'),
    F('sc_psi_change', 'Surface casing pressure change (psi)', 'number', 'Last 7 days minus baseline. Build-up can mean vent flow or gas migration', 'Safety · integrity'),
    F('surface_casing_limit_psi', 'Surface casing pressure limit (psi)', 'number', 'Allowed surface casing pressure', 'Safety · integrity'),
    F('sc_pct_of_limit', 'Surface casing pressure as % of limit', 'number', 'Max 7 d / limit x 100', 'Safety · integrity'),
    F('scvf_status', 'Latest vent flow (SCVF) test result', 'text', 'Pass, Non-serious, Serious or Fail', 'Safety · integrity'),
    F('scvf_rate_m3d', 'Vent flow rate on latest test (m3/d)', 'number', 'Measured surface casing vent flow', 'Safety · integrity'),
    F('corrosion_risk', 'Corrosion risk', 'text', 'Low, Medium or High', 'Safety · integrity'),
    F('sand_prone', 'Sand-prone well', 'boolean', 'Well produces sand (erosion risk)', 'Safety · integrity'),
    F('has_sssv', 'Has subsurface safety valve', 'boolean', 'Well has an SSSV', 'Safety · integrity'),
    // safety: sour gas
    F('sour_class', 'Sour class', 'text', 'Sweet, Sour or Critical sour', 'Safety · H2S'),
    F('h2s_ppm_gas', 'H2S in produced gas (ppm)', 'number', 'From the latest gas analysis', 'Safety · H2S'),
    F('h2s_ambient_max_7d_ppm', 'H2S at surface, max 7 d (ppm)', 'number', 'Highest fixed-monitor H2S reading at the wellsite', 'Safety · H2S'),
    F('epz_m', 'Emergency planning zone (m)', 'number', 'EPZ radius for sour wells', 'Safety · H2S'),
    F('residences_in_epz', 'Residences inside EPZ', 'number', 'Occupied dwellings inside the EPZ', 'Safety · H2S'),
    // safety: process / overpressure
    F('flowline_maop_psi', 'Flowline MAOP (psi)', 'number', 'Maximum allowable operating pressure of the flowline', 'Safety · pressure'),
    F('flowline_psi_max_7d', 'Flowline pressure, max 7 d (psi)', 'number', 'Highest daily flowline pressure', 'Safety · pressure'),
    F('flowline_pct_of_maop', 'Flowline pressure as % of MAOP', 'number', 'Max 7 d / MAOP x 100', 'Safety · pressure'),
    F('flowline_material', 'Flowline material', 'text', 'Steel, Composite, HDPE', 'Safety · pressure'),
    // safety: environment
    F('vent_mtd_m3', 'Vented gas, month to date (m3)', 'number', 'Gas vented Nov 1-22', 'Safety · environment'),
    F('vent_limit_m3_month', 'Venting limit (m3/month)', 'number', 'Monthly vent limit for the site', 'Safety · environment'),
    F('vent_pct_of_limit', 'Venting as % of monthly limit', 'number', 'Month-to-date vented gas / monthly limit x 100', 'Safety · environment'),
    // safety: summaries
    F('tests_overdue', 'Tests / inspections overdue', 'number', 'Count of test types past their due date', 'Safety · compliance'),
    F('critical_tests_overdue', 'Safety-critical tests overdue', 'number', 'Overdue tests marked safety-critical', 'Safety · compliance'),
    F('tests_due_30d', 'Tests due in the next 30 days', 'number', 'Not yet overdue', 'Safety · compliance'),
    F('failed_tests', 'Tests whose latest result failed', 'number', 'Latest result Fail or Serious', 'Safety · compliance'),
    F('next_test_due_date', 'Next test due date', 'date', 'Earliest due date across all tests', 'Safety · compliance'),
    F('next_test_type', 'Next test due', 'text', 'Type of the next test due', 'Safety · compliance'),
    F('safety_events_30d', 'Unplanned safety events (30 d)', 'number', 'All categories', 'Safety · events'),
    F('esd_trips_30d', 'Unplanned ESD trips (30 d)', 'number', 'Emergency shutdowns not planned', 'Safety · events'),
    F('open_safety_events', 'Open safety events', 'number', 'Events not closed out', 'Safety · events'),
    F('unreported_reportable', 'Reportable events not reported', 'number', 'Reportable to the regulator but not yet reported', 'Safety · events'),
    F('days_since_last_safety_event', 'Days since last safety event', 'number', 'Any category', 'Safety · events'),
    F('licence_status', 'Licence status', 'text', 'Active, Suspended, Inactive', 'Safety · status'),
    F('days_since_production', 'Days since the well last produced', 'number', 'For inactive / suspended well tracking', 'Safety · status'),
    // engineer notes (context, not official records)
    F('notes_count', 'Engineer notes on this well', 'number', 'Open notes engineers have written on the well', 'Notes'),
    F('pending_reports', 'Field reports waiting for the official record', 'number', 'Notes reporting a test or event the source system does not show yet', 'Notes'),
    F('unconfirmed_reports', 'Field reports overdue for confirmation', 'number', 'Waiting notes past their expected date with no matching record in the source system', 'Notes'),
  ];
  const TEST_FIELDS = [
    F('test_type', 'Test / inspection type', 'text', 'e.g. Subsurface safety valve test (any type, including ones engineers added)'),
    F('test_group', 'Test group', 'text', 'Integrity, Pressure safety, Detection, Emergency response, Lift equipment, Environment'),
    F('safety_critical', 'Safety-critical test', 'boolean', 'Marked safety-critical in the test catalog'),
    F('last_test_date', 'Last test date', 'date', 'Date of the latest record'),
    F('next_due_date', 'Next due date', 'date', 'Last test + required interval'),
    F('days_until_due', 'Days until due', 'number', 'Negative = overdue'),
    F('days_overdue', 'Days overdue', 'number', '0 if not overdue'),
    F('overdue', 'Overdue', 'boolean', 'Past its due date'),
    F('last_result', 'Latest result', 'text', 'Pass, Fail, Non-serious, Serious'),
    F('result_value', 'Result value', 'number', 'Measured value, e.g. % wall loss or vent flow m3/d'),
    F('result_unit', 'Result unit', 'text', 'Unit of the result value'),
    F('interval_months', 'Required interval (months)', 'number', 'How often the test is required'),
    F('notes', 'Notes', 'text', 'Free text on the latest record'),
    F('source', 'Source system', 'text', 'Where the record comes from (the maintenance / integrity system)'),
  ];
  const EVENT_FIELDS = [
    F('category', 'Event category', 'text', 'ESD trip, PSV lift, H2S alarm, Gas detector alarm, Spill, Gas release, Flowline failure, Fire, Electrical fault, Regulator non-compliance, Near miss, or any category engineers log'),
    F('event_type_original', 'Type as typed in the field', 'text', 'Original wording'),
    F('event_date', 'Event date', 'date', 'When it happened'),
    F('days_ago', 'Days ago', 'number', 'Days before today'),
    F('description', 'Description', 'text', 'Free text'),
    F('planned', 'Planned', 'boolean', 'Planned activity (e.g. ESD function test)'),
    F('status', 'Status', 'text', 'Open or Closed'),
    F('volume_m3', 'Volume (m3)', 'number', 'Spill or release volume'),
    F('substance', 'Substance', 'text', 'Produced water, emulsion, oil, natural gas...'),
    F('reportable', 'Reportable to regulator', 'boolean', 'Must be reported'),
    F('reported_to_regulator', 'Reported to regulator', 'boolean', 'Has been reported'),
    F('source', 'Source system', 'text', 'Where the record comes from (the HSE incident system)'),
  ];
  const DATASETS = {
    well: {label: 'Well readings & status', short: 'well', fields: WELL_FIELDS},
    test: {label: 'Tests & inspections', short: 'test', fields: TEST_FIELDS,
           describe: t => `${t.test_type}: ${['Fail', 'Serious'].includes(t.last_result) ? `last result ${t.last_result.toLowerCase()}` : t.overdue ? `${t.days_overdue} d overdue (was due ${String(t.next_due_date || '').slice(0, 10)})` : `due in ${t.days_until_due} d (${String(t.next_due_date || '').slice(0, 10)})`}${t.result_unit && t.result_value !== null && t.result_value !== undefined && t.result_value !== '' ? `, measured ${t.result_value} ${t.result_unit}` : ''}${['Fail', 'Serious'].includes(t.last_result) ? '' : `; last done ${String(t.last_test_date || '').slice(0, 10)}, ${t.last_result}`}`},
    event: {label: 'Safety events', short: 'event', fields: EVENT_FIELDS,
            describe: e => `${String(e.event_date).slice(0, 10)} ${e.category}${e.volume_m3 ? ` ${e.volume_m3} m3` : ''} · ${e.status}${e.reportable && !e.reported_to_regulator ? ' · not reported' : ''}`},
  };
  const maps = {};
  const rebuild = () => { for (const k in DATASETS) maps[k] = Object.fromEntries(DATASETS[k].fields.map(f => [f.field, f])); };
  rebuild();
  const fieldOf = (ds, name) => (maps[ds || 'well'] || {})[name];
  // engineer-defined per-well fields become well fields named x_<key>
  function setCustomFields(list) {
    DATASETS.well.fields = WELL_FIELDS.concat((list || []).map(c => F('x_' + c.field_key, c.label, {number: 'number', text: 'text', yesno: 'boolean', boolean: 'boolean', date: 'date'}[c.field_type] || 'text', c.help || 'Custom field', 'Custom')));
    rebuild(); api.FIELDS = DATASETS.well.fields; api.FIELD = maps.well;
  }

  const OPS = {
    number: [['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['eq', '='], ['ne', '≠'], ['lt_field', '< field'], ['gt_field', '> field'], ['is_empty', 'is empty'], ['not_empty', 'has a value']],
    boolean: [['is_true', 'is yes'], ['is_false', 'is no']],
    date: [['is_past', 'is before today'], ['within_next_days', 'is within the next N days'], ['within_last_days', 'is within the last N days'], ['more_than_days_ago', 'is more than N days ago'], ['is_empty', 'is empty'], ['not_empty', 'has a value']],
    text: [['eq', 'equals'], ['ne', 'does not equal'], ['one_of', 'is one of (comma list)'], ['contains', 'contains'], ['not_contains', 'does not contain'], ['is_empty', 'is empty'], ['not_empty', 'has a value']],
  };
  const NEEDS_VALUE = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'within_next_days', 'within_last_days', 'more_than_days_ago', 'contains', 'not_contains', 'one_of']);
  const NEEDS_FIELD = new Set(['lt_field', 'gt_field']);

  const R = (id, name, severity, weight, category, conditions, message, action, extra = {}) =>
    Object.assign({id, name, severity, weight, enabled: true, category, match: 'all', dataset: 'well', conditions, message, action}, extra);
  const c = (field, op, value) => value === undefined ? {field, op} : {field, op, value};
  const SAFE_ACT = ' Follow your company\'s integrity and emergency procedures; this flag informs, it does not decide.';
  // group: rules about the same underlying problem; a well only scores the highest weight in a group.
  // fix_cost: rough typical cost to fix (CAD), used for payback ranking of production flags. Placeholders: engineers set their own.
  const GROUPS = {"SAFE_CASING_NEAR_MAASP": "Production casing pressure", "CASING_PRESSURE_RISING": "Production casing pressure", "SAFE_SC_PRESSURE": "Well integrity: vent flow / failed tests", "SAFE_SCVF_SERIOUS": "Well integrity: vent flow / failed tests", "SAFE_FAILED_TEST": "Well integrity: vent flow / failed tests", "SAFE_H2S_AMBIENT": "H2S at surface", "SAFE_H2S_ALARMS": "H2S at surface", "SAFE_SPILL_OPEN": "Releases", "SAFE_GAS_RELEASE": "Releases", "SAFE_UNREPORTED": "Releases", "SAFE_CRITICAL_TEST_OVERDUE": "Tests due", "SAFE_TEST_OVERDUE": "Tests due", "SAFE_TEST_DUE_SOON": "Tests due", "WELL_DOWN_UNPLANNED": "Downtime", "FREQUENT_DOWNTIME": "Downtime"};
  const FIX_COSTS = {"WELL_DOWN_UNPLANNED": 90000, "UNDER_TYPE_CURVE": 15000, "WATER_CUT_JUMP": 40000, "GOR_RISING": 5000, "FREQUENT_DOWNTIME": 8000, "DATA_STALE": 1500};
  const DEFAULT_RULES_RAW = [
    // ---- safety (category "Safety" ranks first when "safety first" is on) ----
    R('SAFE_H2S_AMBIENT', 'H2S detected at surface', 'Critical', 70, 'Safety', [c('h2s_ambient_max_7d_ppm', 'gte', 10)],
      'Fixed monitor read up to {h2s_ambient_max_7d_ppm} ppm H2S at the wellsite in the last 7 days ({sour_class}; residences in EPZ: {residences_in_epz}).', 'Find the source and confirm monitors and access controls.' + SAFE_ACT),
    R('SAFE_SCVF_SERIOUS', 'Serious surface casing vent flow', 'Critical', 70, 'Safety', [c('scvf_status', 'eq', 'Serious')],
      'Latest vent flow test: Serious, {scvf_rate_m3d} m3/d.', 'Plan the repair within the regulator\'s timeline.' + SAFE_ACT),
    R('SAFE_SC_PRESSURE', 'Surface casing pressure building', 'Critical', 60, 'Safety', [c('sc_psi_change', 'gt', 25), c('sc_pct_of_limit', 'gte', 30)],
      'Surface casing pressure up {sc_psi_change} psi to {sc_psi_max_7d} psi ({sc_pct_of_limit}% of limit). Possible vent flow or gas migration.', 'Run a vent flow / gas migration test.' + SAFE_ACT, {match: 'any'}),
    R('SAFE_CASING_NEAR_MAASP', 'Casing pressure near MAASP', 'Critical', 60, 'Safety', [c('casing_pct_of_maasp', 'gte', 80)],
      'Production casing reached {casing_psi_max_7d} psi, {casing_pct_of_maasp}% of its {prod_casing_maasp_psi} psi MAASP.', 'Check for a tubing or packer leak and plan to bleed down.' + SAFE_ACT),
    R('SAFE_UNREPORTED', 'Reportable event not reported', 'Critical', 60, 'Safety', [c('reportable', 'is_true'), c('reported_to_regulator', 'is_false')],
      '{match_count} reportable event(s) not yet reported to the regulator: {matches}.', 'Report it now and record the reference number.', {dataset: 'event'}),
    R('SAFE_FAILED_TEST', 'Failed test not resolved', 'Critical', 60, 'Safety', [c('last_result', 'one_of', 'Fail, Serious')],
      'Latest result failed: {matches}.', 'Plan the repair and retest.' + SAFE_ACT, {dataset: 'test'}),
    R('SAFE_GAS_RELEASE', 'Open gas release, fire or line failure', 'Critical', 60, 'Safety', [c('category', 'one_of', 'Gas release, Fire, Flowline failure'), c('status', 'ne', 'Closed')],
      'Open: {matches}.', 'Confirm the site is isolated and the repair is scheduled.' + SAFE_ACT, {dataset: 'event'}),
    R('SAFE_FLOWLINE_MAOP', 'Flowline pressure near MAOP', 'Critical', 50, 'Safety', [c('flowline_pct_of_maop', 'gte', 90)],
      'Flowline reached {flowline_psi_max_7d} psi, {flowline_pct_of_maop}% of its {flowline_maop_psi} psi MAOP.', 'Check for blockage, hydrates or a closed valve downstream.' + SAFE_ACT),
    R('SAFE_PSV_LIFT', 'Pressure safety valve lifted', 'Critical', 50, 'Safety', [c('category', 'eq', 'PSV lift'), c('days_ago', 'lte', 30)],
      'PSV lift: {matches}.', 'Find why pressure reached set point; inspect and recertify the PSV.' + SAFE_ACT, {dataset: 'event'}),
    R('SAFE_CRITICAL_TEST_OVERDUE', 'Safety-critical test overdue', 'Critical', 50, 'Safety', [c('overdue', 'is_true'), c('safety_critical', 'is_true')],
      'Overdue: {matches}.', 'Schedule the test; check whether the well may keep operating until it is done.', {dataset: 'test'}),
    R('SAFE_SPILL_OPEN', 'Spill not closed out', 'Critical', 50, 'Safety', [c('category', 'eq', 'Spill'), c('status', 'ne', 'Closed')],
      'Open spill: {matches}.', 'Confirm cleanup, sampling and close-out documentation.', {dataset: 'event'}),
    R('SAFE_NONCOMPLIANCE', 'Open regulator non-compliance', 'Critical', 50, 'Safety', [c('category', 'eq', 'Regulator non-compliance'), c('status', 'ne', 'Closed')],
      'Open finding: {matches}.', 'Complete the corrective action before its deadline and respond to the regulator.', {dataset: 'event'}),
    R('SAFE_H2S_ALARMS', 'H2S alarms this week', 'Critical', 40, 'Safety', [c('category', 'eq', 'H2S alarm'), c('days_ago', 'lte', 7), c('planned', 'is_false')],
      '{match_count} H2S alarm(s) in the last 7 days.', 'Investigate the source; check detector calibration.' + SAFE_ACT, {dataset: 'event'}),
    R('SAFE_ESD_TRIPS', 'Repeated unplanned ESD trips', 'Warning', 30, 'Safety', [c('category', 'eq', 'ESD trip'), c('planned', 'is_false'), c('days_ago', 'lte', 30)],
      '{match_count} unplanned emergency shutdowns in 30 days.', 'Find the root cause; repeated trips wear the shutdown system and hide real upsets.', {dataset: 'event', min_count: 3}),
    R('SAFE_ELECTRICAL', 'Electrical fault open', 'Warning', 30, 'Safety', [c('category', 'eq', 'Electrical fault'), c('status', 'ne', 'Closed'), c('days_ago', 'lte', 30)],
      'Open: {matches}.', 'Have an electrician check the drive, cable and grounding before restart.', {dataset: 'event'}),
    R('SAFE_VENT_LIMIT', 'Venting above monthly limit', 'Warning', 30, 'Safety', [c('vent_pct_of_limit', 'gte', 100)],
      'Vented {vent_mtd_m3} m3 this month, {vent_pct_of_limit}% of the {vent_limit_m3_month} m3 limit.', 'Find the vent source (tank, pneumatics, casing gas) and conserve or flare per approval.'),
    R('SAFE_WALL_LOSS', 'High corrosion wall loss', 'Warning', 30, 'Safety', [c('test_type', 'contains', 'Corrosion'), c('result_value', 'gte', 40)],
      'Corrosion survey: {matches}.', 'Plan repair or replacement; review corrosion inhibition.', {dataset: 'test'}),
    R('SAFE_TEST_OVERDUE', 'Test or inspection overdue', 'Warning', 20, 'Safety', [c('overdue', 'is_true'), c('safety_critical', 'is_false')],
      'Overdue: {matches}.', 'Schedule it.', {dataset: 'test'}),
    R('SAFE_INACTIVE', 'Well inactive 12+ months', 'Warning', 20, 'Safety', [c('days_since_production', 'gte', 365)],
      'No production for {days_since_production} days.', 'Check inactive / suspended well requirements with your regulator.'),
    R('SAFE_TEST_DUE_SOON', 'Test due within 30 days', 'Review', 5, 'Safety', [c('days_until_due', 'gte', 0), c('days_until_due', 'lte', 30)],
      'Due soon: {matches}.', 'Book it.', {dataset: 'test'}),
    // ---- production / economics ----
    R('WELL_DOWN_UNPLANNED', 'Well down (unplanned)', 'Critical', 50, 'Downtime', [c('consecutive_down_days', 'gte', 2), c('open_event_planned', 'is_false')],
      'Down {consecutive_down_days} days ({open_event_category}); about {lost_oil_bopd} bbl/d below type curve, ~${value_at_risk_cad_day}/day.', 'Confirm the failure and get the repair or rig scheduled.'),
    R('CASING_PRESSURE_RISING', 'Casing pressure rising', 'Critical', 40, 'Safety', [c('casing_psi_change', 'gt', 150)],
      'Casing pressure up {casing_psi_change} psi to {casing_psi_7d} psi versus baseline.', 'Check for a packer or tubing leak; review against well integrity procedures.'),
    R('UNDER_TYPE_CURVE', 'Underperforming type curve', 'Warning', 30, 'Performance', [c('perf_ratio_7d', 'lt', 0.8), c('consecutive_down_days', 'eq', 0)],
      'Producing at {perf_ratio_7d}x type curve (baseline {perf_ratio_baseline}x); {lost_oil_bopd} bbl/d short.', 'Review pump performance, fluid level and recent changes.'),
    R('WATER_CUT_JUMP', 'Water cut jump', 'Warning', 25, 'Performance', [c('water_cut_change_pts', 'gt', 10)],
      'Water cut up {water_cut_change_pts} points to {water_cut_7d_pct}%.', 'Check for water breakthrough or offset frac hit; consider a well test.'),
    R('GOR_RISING', 'Gas-oil ratio rising', 'Warning', 20, 'Performance', [c('gor_change_pct', 'gt', 40)],
      'Gas-oil ratio up {gor_change_pct}% to {gor_7d} scf/bbl.', 'Check drawdown and pump intake pressure; review against the reservoir plan.'),
    R('FREQUENT_DOWNTIME', 'Frequent short downtime', 'Warning', 20, 'Downtime', [c('downtime_events_14d', 'gte', 5)],
      '{downtime_events_14d} unplanned events in 14 days; uptime {uptime_14d_pct}%.', 'Look for a root cause (pump-off settings, stuffing box, controller).'),
    R('NEGATIVE_MARGIN', 'Operating cost above netback', 'Warning', 20, 'Economics', [c('margin_per_boe', 'lt', 0)],
      'October margin {margin_per_boe} $/boe (cost {loe_per_boe} $/boe).', 'Review operating costs or candidate for optimization / shut-in study.'),
    R('NOTE_UNCONFIRMED', 'Field report not confirmed', 'Review', 5, 'Data', [c('unconfirmed_reports', 'gte', 1)],
      '{unconfirmed_reports} field report(s) not in the source system by the expected date.', 'Check with field staff that the test or event was recorded in the maintenance or HSE system.'),
    R('DATA_STALE', 'SCADA data missing', 'Review', 10, 'Data', [c('days_since_last_data', 'gte', 2)],
      'No SCADA data for {days_since_last_data} days.', 'Ask field / SCADA support to check communications before trusting this well\'s numbers.'),
  ];
  const DEFAULT_RULES = DEFAULT_RULES_RAW.map(r => Object.assign(r, GROUPS[r.id] ? {group: GROUPS[r.id]} : {}, FIX_COSTS[r.id] ? {fix_cost: FIX_COSTS[r.id]} : {}));

  const isEmpty = v => v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v));
  const num = v => isEmpty(v) ? null : Number(v);
  const toDate = v => isEmpty(v) ? null : new Date(String(v).slice(0, 10) + 'T00:00:00Z');
  const days = (a, b) => Math.round((a - b) / 86400000);
  const boolOf = v => v === true || v === 'true' || v === 'Y' || v === 'yes';
  const list = v => String(v ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  function test(cn, row, asOf, ds) {
    const f = fieldOf(ds, cn.field); if (!f) return false;
    const v = row[cn.field];
    switch (cn.op) {
      case 'is_empty': return isEmpty(v);
      case 'not_empty': return !isEmpty(v);
      case 'is_true': return boolOf(v);
      case 'is_false': return !boolOf(v);
      case 'contains': return !isEmpty(v) && String(v).toLowerCase().includes(String(cn.value).toLowerCase());
      case 'not_contains': return isEmpty(v) || !String(v).toLowerCase().includes(String(cn.value).toLowerCase());
      case 'one_of': return !isEmpty(v) && list(cn.value).includes(String(v).trim().toLowerCase());
      case 'is_past': { const d = toDate(v); return !!d && d < asOf; }
      case 'within_next_days': { const d = toDate(v); return !!d && d >= asOf && days(d, asOf) <= Number(cn.value); }
      case 'within_last_days': { const d = toDate(v); return !!d && d <= asOf && days(asOf, d) <= Number(cn.value); }
      case 'more_than_days_ago': { const d = toDate(v); return !!d && days(asOf, d) > Number(cn.value); }
      case 'lt_field': case 'gt_field': {
        const a = num(v), b = num(row[cn.value]); if (a === null || b === null) return false;
        return cn.op === 'lt_field' ? a < b : a > b; }
    }
    if (f.type === 'text') {
      const a = String(v ?? '').trim().toLowerCase(), b = String(cn.value).trim().toLowerCase();
      return cn.op === 'eq' ? a === b : cn.op === 'ne' ? a !== b : false;
    }
    const a = num(v), b = Number(cn.value); if (a === null) return false;
    return {gt: a > b, gte: a >= b, lt: a < b, lte: a <= b, eq: a === b, ne: a !== b}[cn.op] ?? false;
  }

  function fmtVal(field, v, ds) {
    if (isEmpty(v)) return 'none';
    const f = fieldOf(ds, field) || fieldOf('well', field);
    if (f && f.type === 'boolean') return boolOf(v) ? 'yes' : 'no';
    if (f && f.type === 'date') return String(v).slice(0, 10);
    if (f && f.type === 'number') { const n = Number(v); return Math.abs(n) >= 1000 ? n.toLocaleString('en-US', Number.isInteger(n) ? {} : {minimumFractionDigits: 2, maximumFractionDigits: 2}) : String(+n.toFixed(8)); }
    return String(v);
  }
  // {field} inserts a fact (item fields first for test/event rules); {condN} the threshold of condition N; {match_count}, {matches}
  const fill = (tpl, fact, rule, item, matched) => (tpl || '').replace(/\{(\w+)\}/g, (m, k) => {
    const cm = /^cond(\d+)$/.exec(k); const ds = (rule && rule.dataset) || 'well';
    if (cm && rule && rule.conditions[+cm[1] - 1]) { const cd = rule.conditions[+cm[1] - 1]; return fieldOf(ds, cd.value) ? fieldOf(ds, cd.value).label : String(cd.value ?? ''); }
    if (k === 'match_count') return String((matched || []).length);
    if (k === 'matches') return (matched || []).slice(0, 4).map(DATASETS[ds].describe || (x => JSON.stringify(x))).join('; ') + ((matched || []).length > 4 ? `; +${matched.length - 4} more` : '');
    if (item && k in item) return fmtVal(k, item[k], ds);
    return k in fact ? fmtVal(k, fact[k], 'well') : m; });

  const groupBy = (rows, key) => { const g = {}; for (const r of rows || []) (g[r[key]] = g[r[key]] || []).push(r); return g; };

  // items: {test: [...], event: [...]} rows with well_id
  function evaluate(facts, rules, asOfStr, items) {
    const asOf = toDate(asOfStr), out = [];
    const grouped = {test: groupBy(items && items.test, 'well_id'), event: groupBy(items && items.event, 'well_id')};
    for (const r of rules) {
      if (!r.enabled || !r.conditions || !r.conditions.length) continue;
      const ds = r.dataset || 'well';
      for (const fact of facts) {
        if (ds === 'well') {
          const hits = r.conditions.map(cn => test(cn, fact, asOf, 'well'));
          if (!(r.match === 'any' ? hits.some(Boolean) : hits.every(Boolean))) continue;
          out.push({rule_id: r.id, rule_name: r.name, severity: r.severity, category: r.category, dataset: ds, well_id: fact.well_id, well_name: fact.well_name,
            message: fill(r.message, fact, r), action: fill(r.action, fact, r),
            evidence: r.conditions.map((cn, i) => ({field: cn.field, label: fieldOf('well', cn.field)?.label || cn.field, matched: hits[i],
              value: fmtVal(cn.field, fact[cn.field], 'well') + (fieldOf('well', cn.value) && NEEDS_FIELD.has(cn.op) ? ` ${cn.op === 'lt_field' ? '<' : '>'} ${fieldOf('well', cn.value).label} ${fmtVal(cn.value, fact[cn.value], 'well')}` : '')}))});
        } else {
          const rows = grouped[ds][fact.well_id] || [];
          const matched = rows.filter(row => { const h = r.conditions.map(cn => test(cn, row, asOf, ds)); return r.match === 'any' ? h.some(Boolean) : h.every(Boolean); });
          if (matched.length < Math.max(1, Number(r.min_count || 1))) continue;
          out.push({rule_id: r.id, rule_name: r.name, severity: r.severity, category: r.category, dataset: ds, well_id: fact.well_id, well_name: fact.well_name,
            message: fill(r.message, fact, r, matched[0], matched), action: fill(r.action, fact, r, matched[0], matched), items: matched,
            evidence: matched.slice(0, 6).map(m => ({label: DATASETS[ds].short, value: DATASETS[ds].describe(m), matched: true, item: m}))});
        }
      }
    }
    const order = {Critical: 0, Warning: 1, Review: 2};
    return out.sort((a, b) => (order[a.severity] - order[b.severity]) || a.well_id.localeCompare(b.well_id));
  }

  const isSafety = f => String(f.category || '').toLowerCase() === 'safety';
  const SEV = {Critical: 0, Warning: 1, Review: 2};
  const TIERS = ['safety', 'production', 'watch', 'handled'];
  // Has the flag got worse since it was acknowledged? Well rules: any numeric condition moved >10% further past its threshold.
  // Test/event rules: a matching item that wasn't there when it was acknowledged.
  function resurfaced(flag, rule, ack, fact) {
    if (flag.items) {
      const known = new Set(ack.item_ids || []);
      const fresh = flag.items.filter(it => !known.has(it.record_id || it.event_id));
      return fresh.length ? `new since acknowledged: ${(DATASETS[rule.dataset].describe)(fresh[0])}` : null;
    }
    for (const cn of rule.conditions) {
      const old = (ack.ack_values || {})[cn.field], cur = fact[cn.field];
      if (isEmpty(old) || isEmpty(cur) || !['gt', 'gte', 'lt', 'lte'].includes(cn.op)) continue;
      const d = ['gt', 'gte'].includes(cn.op) ? cur - old : old - cur;
      if (d > Math.max(Math.abs(Number(old)) * 0.1, 1e-9)) return `${fieldOf('well', cn.field)?.label || cn.field} worsened from ${fmtVal(cn.field, old)} to ${fmtVal(cn.field, cur)} since acknowledged`;
    }
    return null;
  }
  // Snapshot stored with an acknowledgement so we can tell later whether the flag got worse.
  function ackSnapshot(flag, rule, fact) {
    if (flag.items) return {item_ids: flag.items.map(it => it.record_id || it.event_id)};
    return {ack_values: Object.fromEntries(rule.conditions.map(cn => [cn.field, fact[cn.field] ?? null]))};
  }

  /* Three tiers instead of one score:
       safety     - a Critical/Warning safety flag (when safetyFirst): ordered by severity, then safety points
       production - other Critical/Warning flags: ordered by $/day at risk (mode 'value'), fastest payback ('payback') or points ('score')
       watch      - only Review-level flags
       handled    - every flag acknowledged as being handled (and not worse since) - listed separately, out of the top 10
     Points: rules in the same group count once (highest weight). opts.acks / opts.estimates are keyed "well_id|rule_id". */
  function rank(facts, rules, asOf, mode, engineer, items, opts) {
    opts = opts || {};
    const safetyFirst = opts.safetyFirst !== false, acks = opts.acks || {}, est = opts.estimates || {}, asOfD = toDate(asOf);
    const ruleBy = Object.fromEntries(rules.map(r => [r.id, r]));
    const ex = evaluate(facts.filter(f => !engineer || f.engineer_id === engineer), rules, asOf, items);
    const fact = Object.fromEntries(facts.map(f => [f.well_id, f]));
    const by = {};
    for (const e of ex) (by[e.well_id] = by[e.well_id] || []).push(e);
    const res = [];
    for (const [wid, flags] of Object.entries(by)) {
      const fc = fact[wid];
      for (const f of flags) {
        const r = ruleBy[f.rule_id]; f.weight = Number(r.weight || 0); f.group = r.group || null; f.safety = isSafety(f);
        const a = acks[wid + '|' + f.rule_id];
        if (a && !a.cleared && (!a.until_date || toDate(a.until_date) >= asOfD)) {
          const why = resurfaced(f, r, a, fc);
          if (why) f.resurfaced = why; else f.handled = {type: 'ack', note: a.note, until: a.until_date, by: a.acked_by, owner: a.owner};
        }
        if (!f.handled && !f.safety && opts.woHandled && Number(fc.open_work_orders) > 0) f.handled = {type: 'work_order', note: fc.open_work_order};
        f.fix_cost = !f.safety ? (est[wid + '|' + f.rule_id] ?? r.fix_cost ?? null) : null;
        f.fix_cost_source = est[wid + '|' + f.rule_id] !== undefined ? 'your estimate' : r.fix_cost ? 'rule default' : null;
      }
      const open = flags.filter(f => !f.handled);
      // count each group once (highest weight wins)
      const best = {};
      for (const f of open) { const k = f.group || f.rule_id; if (!best[k] || f.weight > best[k].weight) best[k] = f; }
      for (const f of open) { f.counted = best[f.group || f.rule_id] === f; if (!f.counted) f.counted_with = best[f.group].rule_name; }
      const counted = open.filter(f => f.counted);
      const score = counted.reduce((s, f) => s + f.weight, 0);
      const safetyOpen = open.filter(f => f.safety && f.severity !== 'Review');
      const worstOf = fs => fs.reduce((w, f) => (w === null || SEV[f.severity] < SEV[w]) ? f.severity : w, null);
      const costs = {}; for (const f of open.filter(f => !f.safety && f.fix_cost !== null && f.fix_cost !== undefined && f.fix_cost !== '')) { const k = f.group || f.rule_id; costs[k] = Math.max(costs[k] || 0, Number(f.fix_cost)); }
      const fixCost = Object.keys(costs).length ? Object.values(costs).reduce((a, b) => a + b, 0) : null;
      // dollars per day: oil lost against the type curve, plus the daily operating loss on wells that cost more to run than they earn
      const opLoss = Number(fc.operating_margin_oct_cad) < 0 ? Math.round(-Number(fc.operating_margin_oct_cad) / 31) : 0;
      const value = Number(fc.value_at_risk_cad_day || 0) + opLoss;
      const tier = !open.length ? 'handled' : (safetyFirst && safetyOpen.length) ? 'safety' : open.some(f => f.severity !== 'Review') ? 'production' : 'watch';
      res.push({well_id: wid, fact: fc, flags: flags.sort((a, b) => (!!a.handled - !!b.handled) || (SEV[a.severity] - SEV[b.severity]) || (b.weight - a.weight)),
        score, safety_score: counted.filter(f => f.safety).reduce((s, f) => s + f.weight, 0),
        worst: worstOf(open) || worstOf(flags), safety_worst: worstOf(open.filter(f => f.safety)), safety: open.some(f => f.safety),
        value, value_parts: {lost_oil: Number(fc.value_at_risk_cad_day || 0), operating_loss: opLoss}, fix_cost: fixCost, payback_days: fixCost && value > 0 ? Math.round(fixCost / value) : null,
        tier, tierN: TIERS.indexOf(tier), handled_count: flags.filter(f => f.handled).length});
    }
    const prodSort = {value: (a, b) => (b.value - a.value) || (b.score - a.score),
                      payback: (a, b) => ((a.payback_days ?? 1e12) - (b.payback_days ?? 1e12)) || (b.value - a.value) || (b.score - a.score),
                      score: (a, b) => (b.score - a.score) || (b.value - a.value)}[mode] || ((a, b) => (b.value - a.value) || (b.score - a.score));
    res.sort((a, b) => (a.tierN - b.tierN) ||
      (a.tier === 'safety' ? (SEV[a.safety_worst] - SEV[b.safety_worst]) || (b.safety_score - a.safety_score) || (b.score - a.score) || (b.value - a.value)
       : a.tier === 'production' ? prodSort(a, b) : (b.score - a.score) || (b.value - a.value)));
    return res;
  }

  function validateRule(r) {
    const errs = [], ds = r.dataset || 'well';
    if (!DATASETS[ds]) errs.push('Pick what the rule looks at.');
    if (!r.name || !r.name.trim()) errs.push('Give the rule a name.');
    if (!['Critical', 'Warning', 'Review'].includes(r.severity)) errs.push('Pick a severity.');
    if (r.weight === '' || isNaN(Number(r.weight)) || Number(r.weight) < 0) errs.push('Weight must be a number of points (0 or more).');
    if (ds !== 'well' && (isNaN(Number(r.min_count || 1)) || Number(r.min_count || 1) < 1)) errs.push('"At least" must be 1 or more.');
    if (!r.conditions || !r.conditions.length) errs.push('Add at least one condition.');
    if (r.fix_cost !== undefined && r.fix_cost !== null && r.fix_cost !== '' && (isNaN(Number(r.fix_cost)) || Number(r.fix_cost) < 0)) errs.push('Typical fix cost must be a dollar amount (0 or more), or left empty.');
    (r.conditions || []).forEach((cn, i) => {
      const f = fieldOf(ds, cn.field); if (!f) { errs.push(`Condition ${i + 1}: pick a field.`); return; }
      if (!OPS[f.type].some(([o]) => o === cn.op)) errs.push(`Condition ${i + 1}: pick an operator.`);
      if (NEEDS_VALUE.has(cn.op) && (cn.value === '' || cn.value === undefined || (f.type !== 'text' && isNaN(Number(cn.value))))) errs.push(`Condition ${i + 1}: enter ${f.type === 'text' ? 'a value' : 'a number'}.`);
      if (NEEDS_FIELD.has(cn.op) && !fieldOf(ds, cn.value)) errs.push(`Condition ${i + 1}: pick the field to compare with.`);
    });
    return errs;
  }

  // does a single value satisfy a condition? (used to highlight the cells that crossed a rule's threshold)
  const matchValue = (cn, v, ds, asOf) => test(cn, {[cn.field]: v}, toDate(asOf), ds || 'well');
  const api = {matchValue, GROUPS, FIX_COSTS, TIERS, ackSnapshot, DATASETS, FIELDS: WELL_FIELDS, FIELD: maps.well, fieldOf, setCustomFields, OPS, NEEDS_VALUE, NEEDS_FIELD, DEFAULT_RULES, evaluate, rank, validateRule, fill, fmtVal, isSafety};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FlagEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
