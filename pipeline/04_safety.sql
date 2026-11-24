-- SAFETY: bronze -> silver -> gold for well safety, plus app tables engineers write to (manual tests, events, custom fields)
-- and views that merge system data with manual entries. "Today" for due dates = 2026-11-23; data through 2026-11-22.

CREATE OR REPLACE TABLE workspace.well_ops.bronze_well_safety_register
COMMENT 'BRONZE. Well safety register as exported (East-area rows in kPa).'
AS SELECT *, _metadata.file_name AS _source_file, _metadata.file_modification_time AS _loaded_at,
  substr(sha2(concat_ws('|', well_id, _metadata.file_name), 256), 1, 12) AS _bronze_id
FROM read_files('/Volumes/workspace/well_ops/landing/master/well_safety_register.csv', format => 'csv', header => true, inferSchema => true);

CREATE OR REPLACE TABLE workspace.well_ops.bronze_safety_readings
COMMENT 'BRONZE. Daily safety SCADA readings (monthly files): surface casing pressure, flowline max pressure, ambient H2S, vented gas. -999 = sensor error.'
AS SELECT *, _metadata.file_name AS _source_file, _metadata.file_modification_time AS _loaded_at,
  substr(sha2(concat_ws('|', _metadata.file_name, well_id, reading_date), 256), 1, 12) AS _bronze_id
FROM read_files('/Volumes/workspace/well_ops/landing/safety/', format => 'csv', header => true, inferSchema => true, pathGlobFilter => 'safety_readings_*.csv');

CREATE OR REPLACE TABLE workspace.well_ops.bronze_compliance_tests
COMMENT 'BRONZE. Test and inspection history from the integrity / compliance system. Results typed inconsistently.'
AS SELECT *, _metadata.file_name AS _source_file, _metadata.file_modification_time AS _loaded_at,
  substr(sha2(concat_ws('|', test_id, well_id), 256), 1, 12) AS _bronze_id
FROM read_files('/Volumes/workspace/well_ops/landing/compliance/', format => 'csv', header => true, inferSchema => true);

CREATE OR REPLACE TABLE workspace.well_ops.bronze_safety_events
COMMENT 'BRONZE. Safety event log (ESD trips, PSV lifts, alarms, spills, releases, regulator findings) as entered in the field.'
AS SELECT *, _metadata.file_name AS _source_file, _metadata.file_modification_time AS _loaded_at,
  substr(sha2(concat_ws('|', event_id, well_id), 256), 1, 12) AS _bronze_id
FROM read_files('/Volumes/workspace/well_ops/landing/safety/', format => 'csv', header => true, inferSchema => true, pathGlobFilter => 'safety_events.csv');

DELETE FROM workspace.well_ops.silver_cleaning_rules WHERE rule_id IN ('SAFETY-UNITS', 'SAFETY-SENSOR-ERR', 'TEST-RESULT', 'TEST-CATALOG', 'EVENT-CATEGORY', 'EVENT-FLAGS');

INSERT INTO workspace.well_ops.silver_cleaning_rules SELECT * FROM VALUES
  ('SAFETY-UNITS', 'silver_well_safety', 'Safety register pressures exported in kPa are converted to psi (kPa / 6.894757).'),
  ('SAFETY-SENSOR-ERR', 'silver_safety_readings', 'Safety readings of -999 are sensor errors and are set to null.'),
  ('TEST-RESULT', 'silver_compliance_tests', 'Test results typed inconsistently (PASS, passed, OK - pass, Fail - leak, SERIOUS - flow...) are normalized to Pass, Fail, Non-serious or Serious; the original text is kept.'),
  ('TEST-CATALOG', 'silver_compliance_tests', 'Each test is joined to the test catalog for its group, required interval and whether it is safety-critical.'),
  ('EVENT-CATEGORY', 'silver_safety_events', 'Safety event type and description are categorized with ai_classify into a fixed list; the original type is kept.'),
  ('EVENT-FLAGS', 'silver_safety_events', 'Y/N fields (planned, reportable, reported to regulator) converted to true/false.')
  AS t(rule_id, target_table, description);

CREATE OR REPLACE TABLE workspace.well_ops.silver_well_safety
COMMENT 'SILVER. One row per well: hazards and limits, all pressures in psi.'
AS SELECT well_id, licence_status, sour_class, cast(h2s_ppm_gas AS INT) AS h2s_ppm_gas, cast(epz_m AS INT) AS epz_m, cast(residences_in_epz AS INT) AS residences_in_epz,
  has_sssv = 'Y' AS has_sssv,
  round(CASE WHEN pressure_unit = 'kPa' THEN prod_casing_maasp / 6.894757 ELSE prod_casing_maasp END, 0) AS prod_casing_maasp_psi,
  round(CASE WHEN pressure_unit = 'kPa' THEN surface_casing_limit / 6.894757 ELSE surface_casing_limit END, 0) AS surface_casing_limit_psi,
  round(CASE WHEN pressure_unit = 'kPa' THEN wellhead_rating / 6.894757 ELSE wellhead_rating END, 0) AS wellhead_rating_psi,
  round(CASE WHEN pressure_unit = 'kPa' THEN flowline_maop / 6.894757 ELSE flowline_maop END, 0) AS flowline_maop_psi,
  flowline_material, cast(vent_limit_m3_month AS DOUBLE) AS vent_limit_m3_month, corrosion_risk, sand_prone = 'Y' AS sand_prone,
  pressure_unit AS pressure_unit_reported,
  CASE WHEN pressure_unit = 'kPa' THEN array('SAFETY-UNITS') ELSE array() END AS rules_applied, _bronze_id
FROM workspace.well_ops.bronze_well_safety_register;

CREATE OR REPLACE TABLE workspace.well_ops.silver_safety_readings
COMMENT 'SILVER. Daily safety readings with sensor errors nulled.'
AS SELECT well_id, cast(reading_date AS DATE) AS reading_date,
  CASE WHEN sc_psi = -999 THEN NULL ELSE sc_psi END AS sc_psi,
  CASE WHEN flowline_psi_max = -999 THEN NULL ELSE flowline_psi_max END AS flowline_psi_max,
  CASE WHEN h2s_ambient_ppm_max = -999 THEN NULL ELSE h2s_ambient_ppm_max END AS h2s_ambient_ppm_max,
  vent_gas_m3,
  CASE WHEN -999 IN (sc_psi, flowline_psi_max, h2s_ambient_ppm_max) THEN array('SAFETY-SENSOR-ERR') ELSE array() END AS rules_applied,
  _bronze_id
FROM workspace.well_ops.bronze_safety_readings;

CREATE OR REPLACE TABLE workspace.well_ops.silver_test_catalog
COMMENT 'SILVER. Test and inspection types: group, required interval and whether the test is safety-critical. Engineers can add their own types in the app.'
AS SELECT * FROM VALUES
  ('Surface casing vent flow test', 'Integrity', 12, true), ('Packer isolation test', 'Integrity', 24, true), ('Corrosion (UT) survey', 'Integrity', 24, false),
  ('Wellhead master valve test', 'Pressure safety', 12, true), ('Subsurface safety valve test', 'Pressure safety', 6, true), ('PSV recertification', 'Pressure safety', 36, true),
  ('ESD function test', 'Pressure safety', 12, true), ('Flowline pressure test', 'Pressure safety', 60, true), ('H2S detector calibration', 'Detection', 6, true),
  ('H2S emergency response plan review', 'Emergency response', 12, true), ('Pumping unit guard and brake inspection', 'Lift equipment', 12, true),
  ('ESP insulation resistance test', 'Lift equipment', 6, false), ('LDAR fugitive emissions survey', 'Environment', 12, false), ('Secondary containment inspection', 'Environment', 12, false)
  AS t(test_type, test_group, interval_months, safety_critical);

CREATE OR REPLACE TABLE workspace.well_ops.silver_compliance_tests
COMMENT 'SILVER. Every test record with normalized result and catalog attributes.'
AS SELECT t.test_id, t.well_id, t.test_type, c.test_group, c.interval_months, c.safety_critical, cast(t.test_date AS DATE) AS test_date,
  CASE WHEN lower(t.result) LIKE '%serious%' AND lower(t.result) NOT LIKE '%non%' THEN 'Serious'
       WHEN lower(t.result) LIKE '%non-serious%' THEN 'Non-serious'
       WHEN lower(t.result) LIKE '%fail%' THEN 'Fail' WHEN lower(t.result) LIKE '%pass%' THEN 'Pass' ELSE 'Unknown' END AS result_status,
  t.result AS result_original, cast(t.result_value AS DOUBLE) AS result_value, t.result_unit, t.performed_by, t.notes,
  array('TEST-RESULT', 'TEST-CATALOG') AS rules_applied, t._bronze_id
FROM workspace.well_ops.bronze_compliance_tests t LEFT JOIN workspace.well_ops.silver_test_catalog c USING (test_type);

CREATE OR REPLACE TABLE workspace.well_ops.silver_safety_events
COMMENT 'SILVER. Safety events with AI-assigned category (ai_classify), booleans cleaned, original type kept.'
AS SELECT event_id, well_id, cast(event_ts AS TIMESTAMP) AS event_ts, cast(event_ts AS DATE) AS event_date,
  ai_classify(concat(event_type, ': ', description), array('ESD trip', 'PSV lift', 'H2S alarm', 'Gas detector alarm', 'Spill', 'Gas release', 'Flowline failure',
     'Fire', 'Electrical fault', 'Regulator non-compliance', 'Near miss')) AS category,
  event_type AS event_type_original, description, planned = 'Y' AS planned, cast(volume_m3 AS DOUBLE) AS volume_m3, substance,
  reportable = 'Y' AS reportable, reported_to_regulator = 'Y' AS reported_to_regulator, status,
  array('EVENT-CATEGORY', 'EVENT-FLAGS') AS rules_applied, _bronze_id
FROM workspace.well_ops.bronze_safety_events;

-- -------- app tables (written by the app; the service principal gets MODIFY on these only) --------
CREATE TABLE IF NOT EXISTS workspace.well_ops.app_compliance_entries (entry_id STRING, well_id STRING, test_type STRING, test_group STRING, interval_months INT,
  safety_critical BOOLEAN, test_date DATE, result_status STRING, result_value DOUBLE, result_unit STRING, notes STRING, entered_by STRING, entered_at TIMESTAMP)
COMMENT 'Tests and inspections logged by engineers in Well Watch (any type, including ones not in the catalog).';

CREATE TABLE IF NOT EXISTS workspace.well_ops.app_safety_event_entries (event_id STRING, well_id STRING, event_date DATE, category STRING, description STRING,
  planned BOOLEAN, volume_m3 DOUBLE, substance STRING, reportable BOOLEAN, reported_to_regulator BOOLEAN, status STRING, entered_by STRING, entered_at TIMESTAMP)
COMMENT 'Safety events logged by engineers in Well Watch (any category).';

CREATE TABLE IF NOT EXISTS workspace.well_ops.app_event_updates (event_id STRING, status STRING, reported_to_regulator BOOLEAN, note STRING, updated_by STRING, updated_at TIMESTAMP)
COMMENT 'Status updates engineers make to safety events (system or manual). Latest row per event wins.';

CREATE TABLE IF NOT EXISTS workspace.well_ops.app_custom_fields (field_key STRING, label STRING, field_type STRING, help STRING, created_by STRING, created_at TIMESTAMP)
COMMENT 'Per-well fields engineers define themselves (number, text, yes/no, date) so any safety measure can be tracked with a rule.';

CREATE TABLE IF NOT EXISTS workspace.well_ops.app_well_attributes (well_id STRING, field_key STRING, value STRING, updated_by STRING, updated_at TIMESTAMP)
COMMENT 'Values of engineer-defined fields per well. Latest row per well and field wins.';

CREATE TABLE IF NOT EXISTS workspace.well_ops.app_flag_settings (engineer_id STRING, safety_first BOOLEAN, saved_by STRING, saved_at TIMESTAMP)
COMMENT 'Ranking settings per engineer (latest row wins).';

-- -------- gold --------
CREATE OR REPLACE TABLE workspace.well_ops.gold_safety_daily
COMMENT 'GOLD. Daily safety readings joined to each well''s limits, with percent of limit.'
AS SELECT r.well_id, r.reading_date, r.sc_psi, s.surface_casing_limit_psi, round(100 * r.sc_psi / s.surface_casing_limit_psi, 1) AS sc_pct_of_limit,
  r.flowline_psi_max, s.flowline_maop_psi, round(100 * r.flowline_psi_max / s.flowline_maop_psi, 1) AS flowline_pct_of_maop,
  d.casing_psi, s.prod_casing_maasp_psi, round(100 * d.casing_psi / s.prod_casing_maasp_psi, 1) AS casing_pct_of_maasp,
  r.h2s_ambient_ppm_max, r.vent_gas_m3, s.vent_limit_m3_month, r._bronze_id
FROM workspace.well_ops.silver_safety_readings r JOIN workspace.well_ops.silver_well_safety s USING (well_id)
LEFT JOIN workspace.well_ops.gold_daily_well d ON d.well_id = r.well_id AND d.prod_date = r.reading_date;

CREATE OR REPLACE VIEW workspace.well_ops.gold_v_compliance_items
COMMENT 'GOLD VIEW. Latest test of each type per well, from the compliance system and from tests logged in the app (whichever is newer), with next due date. Today = 2026-11-23.'
AS WITH allt AS (
  SELECT well_id, test_type, test_group, interval_months, safety_critical, test_date, result_status, result_value, result_unit, notes, 'system' AS source, test_id AS record_id
  FROM workspace.well_ops.silver_compliance_tests
  UNION ALL
  SELECT well_id, test_type, test_group, interval_months, safety_critical, test_date, result_status, result_value, result_unit, notes, 'app: ' || entered_by AS source, entry_id
  FROM workspace.well_ops.app_compliance_entries),
latest AS (SELECT *, row_number() OVER (PARTITION BY well_id, test_type ORDER BY test_date DESC, source) AS rn FROM allt)
SELECT well_id, test_type, test_group, interval_months, safety_critical, test_date AS last_test_date, result_status AS last_result, result_value, result_unit, notes, source, record_id,
  add_months(test_date, interval_months) AS next_due_date, datediff(add_months(test_date, interval_months), DATE'2026-11-23') AS days_until_due,
  datediff(add_months(test_date, interval_months), DATE'2026-11-23') < 0 AS overdue, greatest(0, -datediff(add_months(test_date, interval_months), DATE'2026-11-23')) AS days_overdue
FROM latest WHERE rn = 1;

CREATE OR REPLACE VIEW workspace.well_ops.gold_v_safety_events
COMMENT 'GOLD VIEW. Safety events from the field log and from the app, with the latest status update applied. days_ago relative to 2026-11-23.'
AS WITH alle AS (
  SELECT event_id, well_id, event_date, category, event_type_original, description, planned, volume_m3, substance, reportable, reported_to_regulator, status, 'system' AS source
  FROM workspace.well_ops.silver_safety_events
  UNION ALL
  SELECT event_id, well_id, event_date, category, category, description, planned, volume_m3, substance, reportable, reported_to_regulator, status, 'app: ' || entered_by
  FROM workspace.well_ops.app_safety_event_entries),
upd AS (SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY event_id ORDER BY updated_at DESC) rn FROM workspace.well_ops.app_event_updates) WHERE rn = 1)
SELECT e.event_id, e.well_id, e.event_date, e.category, e.event_type_original, e.description, e.planned, e.volume_m3, e.substance, e.reportable,
  coalesce(u.reported_to_regulator, e.reported_to_regulator) AS reported_to_regulator, coalesce(u.status, e.status) AS status, e.source,
  u.note AS last_update_note, u.updated_by AS last_updated_by, datediff(DATE'2026-11-23', e.event_date) AS days_ago
FROM alle e LEFT JOIN upd u USING (event_id);

CREATE OR REPLACE VIEW workspace.well_ops.gold_v_well_safety
COMMENT 'GOLD VIEW. One row per well with every safety field the flag rules use. Recent = Nov 16-22, baseline = Oct 10 - Nov 8, month to date = Nov 1-22.'
AS WITH rd AS (
  SELECT well_id,
    max(CASE WHEN reading_date >= '2026-11-16' THEN sc_psi END) AS sc_psi_max_7d,
    avg(CASE WHEN reading_date >= '2026-11-16' THEN sc_psi END) - avg(CASE WHEN reading_date BETWEEN '2026-10-10' AND '2026-11-08' THEN sc_psi END) AS sc_psi_change,
    max(CASE WHEN reading_date >= '2026-11-16' THEN flowline_psi_max END) AS flowline_psi_max_7d,
    max(CASE WHEN reading_date >= '2026-11-16' THEN casing_psi END) AS casing_psi_max_7d,
    max(CASE WHEN reading_date >= '2026-11-16' THEN h2s_ambient_ppm_max END) AS h2s_ambient_max_7d_ppm,
    sum(CASE WHEN reading_date >= '2026-11-01' THEN vent_gas_m3 END) AS vent_mtd_m3
  FROM workspace.well_ops.gold_safety_daily GROUP BY well_id),
ci AS (
  SELECT well_id, count_if(overdue) AS tests_overdue, count_if(overdue AND safety_critical) AS critical_tests_overdue,
    count_if(NOT overdue AND days_until_due <= 30) AS tests_due_30d, count_if(last_result IN ('Fail', 'Serious')) AS failed_tests,
    min_by(test_type, next_due_date) AS next_test_type, min(next_due_date) AS next_test_due_date,
    max(CASE WHEN test_type = 'Surface casing vent flow test' THEN last_result END) AS scvf_status,
    max(CASE WHEN test_type = 'Surface casing vent flow test' THEN result_value END) AS scvf_rate_m3d
  FROM workspace.well_ops.gold_v_compliance_items GROUP BY well_id),
se AS (
  SELECT well_id, count_if(days_ago <= 30 AND NOT planned) AS safety_events_30d, count_if(days_ago <= 30 AND NOT planned AND category = 'ESD trip') AS esd_trips_30d,
    count_if(status <> 'Closed') AS open_safety_events, count_if(reportable AND NOT reported_to_regulator) AS unreported_reportable,
    min(days_ago) AS days_since_last_safety_event
  FROM workspace.well_ops.gold_v_safety_events GROUP BY well_id),
lp AS (SELECT well_id, datediff(DATE'2026-11-22', max(CASE WHEN hours_on > 0 THEN prod_date END)) AS days_since_production FROM workspace.well_ops.gold_daily_well GROUP BY well_id)
SELECT s.well_id, s.licence_status, s.sour_class, s.h2s_ppm_gas, s.epz_m, s.residences_in_epz, s.has_sssv, s.corrosion_risk, s.sand_prone, s.flowline_material,
  s.prod_casing_maasp_psi, rd.casing_psi_max_7d, round(100 * rd.casing_psi_max_7d / s.prod_casing_maasp_psi, 1) AS casing_pct_of_maasp,
  s.wellhead_rating_psi,
  round(rd.sc_psi_max_7d, 1) AS sc_psi_max_7d, round(rd.sc_psi_change, 1) AS sc_psi_change, s.surface_casing_limit_psi, round(100 * rd.sc_psi_max_7d / s.surface_casing_limit_psi, 1) AS sc_pct_of_limit,
  s.flowline_maop_psi, round(rd.flowline_psi_max_7d, 1) AS flowline_psi_max_7d, round(100 * rd.flowline_psi_max_7d / s.flowline_maop_psi, 1) AS flowline_pct_of_maop,
  coalesce(rd.h2s_ambient_max_7d_ppm, 0) AS h2s_ambient_max_7d_ppm,
  round(rd.vent_mtd_m3, 0) AS vent_mtd_m3, s.vent_limit_m3_month, round(100 * rd.vent_mtd_m3 / s.vent_limit_m3_month, 1) AS vent_pct_of_limit,
  ci.scvf_status, ci.scvf_rate_m3d, coalesce(ci.tests_overdue, 0) AS tests_overdue, coalesce(ci.critical_tests_overdue, 0) AS critical_tests_overdue,
  coalesce(ci.tests_due_30d, 0) AS tests_due_30d, coalesce(ci.failed_tests, 0) AS failed_tests, ci.next_test_type, ci.next_test_due_date,
  coalesce(se.safety_events_30d, 0) AS safety_events_30d, coalesce(se.esd_trips_30d, 0) AS esd_trips_30d, coalesce(se.open_safety_events, 0) AS open_safety_events,
  coalesce(se.unreported_reportable, 0) AS unreported_reportable, se.days_since_last_safety_event, lp.days_since_production
FROM workspace.well_ops.silver_well_safety s LEFT JOIN rd USING (well_id) LEFT JOIN ci USING (well_id) LEFT JOIN se USING (well_id) LEFT JOIN lp USING (well_id)
