-- Production issues, downtime reason codes, repeat failures and the morning call.
-- Configuration (reason codes, text-to-code patterns, approval limits) lives in gold_* tables maintained by operations.
-- Issue records are append-only: the latest row per issue_id is current, and every action goes to app_issue_events.

-- Standard downtime reason codes. Operations owns this list.
CREATE OR REPLACE TABLE workspace.well_ops.gold_reason_codes (
  reason_code STRING, label STRING, reason_group STRING COMMENT 'Mechanical, Electrical, Facility, Midstream, Weather, Planned, Data',
  description STRING)
COMMENT 'GOLD. Standard downtime reason codes. Maintained by operations.';

INSERT INTO workspace.well_ops.gold_reason_codes VALUES
  ('ROD-PART', 'Rod part', 'Mechanical', 'Sucker rod string parted downhole; needs a service rig'),
  ('TUBING-LEAK', 'Tubing leak', 'Mechanical', 'Hole in the production tubing'),
  ('STUFFING-BOX', 'Stuffing box leak', 'Mechanical', 'Leak at the polished rod stuffing box'),
  ('ROD-CLAMP', 'Polished rod clamp slipped', 'Mechanical', 'Clamp slipped on the polished rod'),
  ('PUMPED-OFF', 'Pumped off', 'Mechanical', 'Pump ran the fluid level down; normal pump-off cycle or undersized inflow'),
  ('POC-FAULT', 'Pump-off controller fault', 'Electrical', 'Pump-off controller faulted and stopped the unit'),
  ('ROD-PUMP-DOWN', 'Rod pump down, cause not found', 'Mechanical', 'Unit found down and restarted; cause not recorded'),
  ('GAS-LOCK', 'Gas lock', 'Mechanical', 'Gas in the pump stops it lifting fluid'),
  ('ESP-FAIL', 'ESP failure', 'Electrical', 'Electric submersible pump failed and would not restart'),
  ('POWER', 'Power outage or bump', 'Electrical', 'Utility power outage or momentary power bump'),
  ('FROZEN-LINE', 'Frozen line', 'Weather', 'Line or equipment froze'),
  ('WEATHER', 'Weather, other', 'Weather', 'Access or operations stopped by weather'),
  ('LINE-PRESSURE', 'High line pressure / pipeline restriction', 'Midstream', 'Gathering or sales line pressure too high to flow'),
  ('FACILITY-UPSET', 'Facility upset', 'Facility', 'Battery or facility upset shut the well in'),
  ('PLANNED', 'Planned work', 'Planned', 'Planned workover, turnaround or maintenance'),
  ('DATA-ERROR', 'Data error, not a real outage', 'Data', 'Meter, communications or entry error; no production was lost'),
  ('OTHER', 'Other', 'Other', 'None of the above; say what in the note');

-- How the free-text reasons people typed map onto the standard codes. Lowest priority number wins.
CREATE OR REPLACE TABLE workspace.well_ops.gold_reason_code_map (
  pattern STRING COMMENT 'Case-insensitive regular expression matched against the reason as typed', reason_code STRING, priority INT)
COMMENT 'GOLD. Maps free-text downtime reasons onto standard reason codes. Maintained by operations.';

INSERT INTO workspace.well_ops.gold_reason_code_map VALUES
  ('planned|turnaround|workover', 'PLANNED', 1),
  ('esp', 'ESP-FAIL', 2),
  ('stuffing box', 'STUFFING-BOX', 3),
  ('clamp', 'ROD-CLAMP', 3),
  ('pump off controller|poc', 'POC-FAULT', 3),
  ('pumped off', 'PUMPED-OFF', 4),
  ('rod part', 'ROD-PART', 3),
  ('tubing', 'TUBING-LEAK', 3),
  ('gas lock', 'GAS-LOCK', 3),
  ('rod pump down', 'ROD-PUMP-DOWN', 5),
  ('power', 'POWER', 5),
  ('frozen|freeze', 'FROZEN-LINE', 4),
  ('weather', 'WEATHER', 6),
  ('line pressure|pipeline', 'LINE-PRESSURE', 5),
  ('facility', 'FACILITY-UPSET', 6);

-- Approval limits and thresholds. Demo values; set your own.
CREATE OR REPLACE TABLE workspace.well_ops.gold_issue_settings (setting STRING, value STRING, description STRING)
COMMENT 'GOLD. Production issue settings: approval limits and thresholds. Maintained by operations; demo values.';

INSERT INTO workspace.well_ops.gold_issue_settings VALUES
  ('approval_threshold_cad', '25000', 'A fix estimated at or above this cost needs approval (AFE) before it is scheduled'),
  ('approver_role', 'Production superintendent', 'Who approves fixes above the threshold'),
  ('repeat_failure_count', '3', 'A well with this many unplanned stops for the same reason ...'),
  ('repeat_failure_days', '90', '... within this many days is a repeat failure'),
  ('verify_days', '3', 'Days of production data after the fix needed to verify it');

-- Every downtime event with its standard reason code and what it cost.
-- Lost oil = hours lost / 24 x the well''s expected (type curve) oil rate that day; gas follows the day''s GOR.
CREATE OR REPLACE VIEW workspace.well_ops.gold_v_downtime_coded
COMMENT 'GOLD. Downtime events with standard reason codes and estimated lost oil, BOE and value (CAD, after royalty).'
AS WITH coded AS (
  SELECT e.*, m.reason_code, row_number() OVER (PARTITION BY e._bronze_id ORDER BY m.priority) rn
  FROM workspace.well_ops.gold_downtime_events e
  LEFT JOIN workspace.well_ops.gold_reason_code_map m ON lower(e.reason_original) RLIKE m.pattern
), p AS (
  SELECT max(CASE WHEN assumption = 'oil_price_cad_bbl' THEN value END) oil_price,
         max(CASE WHEN assumption = 'gas_price_cad_mcf' THEN value END) gas_price,
         max(CASE WHEN assumption = 'royalty_rate' THEN value END) royalty
  FROM workspace.well_ops.gold_price_assumptions)
SELECT c.well_id, c.well_name, c.engineer_id, c.event_date, c.event_start, c.hours_lost, c.is_open, c.planned, c.reason_original, c.category,
       coalesce(c.reason_code, 'OTHER') AS reason_code, rc.label AS reason_label, rc.reason_group,
       round(coalesce(c.hours_lost, 0) / 24 * d.target_oil_bopd, 1) AS lost_oil_bbl,
       round(coalesce(c.hours_lost, 0) / 24 * d.target_oil_bopd * (1 + coalesce(d.gor_scf_bbl, 0) / 6000), 1) AS lost_boe,
       round(coalesce(c.hours_lost, 0) / 24 * d.target_oil_bopd * (p.oil_price + coalesce(d.gor_scf_bbl, 0) / 1000 * p.gas_price) * (1 - p.royalty), 0) AS lost_value_cad,
       c._bronze_id, c._source_file
FROM coded c
CROSS JOIN p
LEFT JOIN workspace.well_ops.gold_reason_codes rc ON rc.reason_code = coalesce(c.reason_code, 'OTHER')
LEFT JOIN workspace.well_ops.gold_daily_well d ON d.well_id = c.well_id AND d.prod_date = c.event_date
WHERE c.rn = 1;

-- Repeat failures: unplanned stops for the same reason on the same well, over the settings window.
CREATE OR REPLACE VIEW workspace.well_ops.gold_v_repeat_failures
COMMENT 'GOLD. Unplanned stops per well and reason code in the repeat-failure window, with lost BOE. repeat = at or above the setting.'
AS WITH s AS (
  SELECT cast(max(CASE WHEN setting = 'repeat_failure_count' THEN value END) AS INT) n,
         cast(max(CASE WHEN setting = 'repeat_failure_days' THEN value END) AS INT) days
  FROM workspace.well_ops.gold_issue_settings),
asof AS (SELECT max(prod_date) d FROM workspace.well_ops.gold_daily_well)
SELECT c.well_id, c.well_name, c.engineer_id, c.reason_code, c.reason_label, count(*) AS stops, max(c.event_date) AS last_stop,
       round(sum(c.lost_boe), 1) AS lost_boe, round(sum(c.lost_value_cad), 0) AS lost_value_cad, s.days AS window_days, count(*) >= s.n AS repeat
FROM workspace.well_ops.gold_v_downtime_coded c CROSS JOIN s CROSS JOIN asof
WHERE NOT c.planned AND c.reason_code <> 'DATA-ERROR' AND c.event_date > date_sub(asof.d, s.days)
GROUP BY c.well_id, c.well_name, c.engineer_id, c.reason_code, c.reason_label, s.days, s.n;

CREATE TABLE IF NOT EXISTS workspace.well_ops.app_production_issues (
  issue_id STRING, well_id STRING, engineer_id STRING, title STRING, source STRING COMMENT 'flag, manual or morning call',
  rule_ids STRING COMMENT 'JSON list of the flags merged into this issue', state STRING,
  lost_bopd DOUBLE COMMENT 'Lost oil per day when detected', value_cad_day DOUBLE COMMENT 'Dollars per day at risk when detected',
  baseline_oil_bopd DOUBLE COMMENT 'Oil rate (7-day) when detected', expected_oil_bopd DOUBLE COMMENT 'Type-curve rate when detected',
  triage_result STRING, diagnosis STRING, fix_type STRING, fix_plan STRING, est_cost_cad DOUBLE,
  approval STRING COMMENT 'Approved or Rejected, by whom and why', scheduled_date DATE, work_order STRING, fix_done_date DATE, fix_done_note STRING,
  reason_code STRING, lost_oil_bbl DOUBLE, lost_boe DOUBLE, actual_cost_cad DOUBLE, outcome STRING, outcome_note STRING, dismissed_reason STRING,
  opened_by STRING, opened_at TIMESTAMP, updated_by STRING, updated_at TIMESTAMP)
TBLPROPERTIES ('delta.appendOnly' = 'true')
COMMENT 'Production issues from detection to close. Append-only: the latest row per issue_id is the current record.';

CREATE TABLE IF NOT EXISTS workspace.well_ops.app_issue_events (
  event_id STRING, issue_id STRING, at TIMESTAMP, actor STRING, action STRING, from_state STRING, to_state STRING, detail STRING, detail_json STRING)
TBLPROPERTIES ('delta.appendOnly' = 'true')
COMMENT 'Audit trail and thread for production issues. Insert-only.';

CREATE TABLE IF NOT EXISTS workspace.well_ops.app_morning_calls (
  call_id STRING, engineer_id STRING, call_date DATE, briefing_json STRING COMMENT 'The briefing and facts shown at the call',
  items_json STRING COMMENT 'Agenda items with the notes and decisions captured', started_by STRING, saved_at TIMESTAMP)
TBLPROPERTIES ('delta.appendOnly' = 'true')
COMMENT 'Morning calls: agenda, notes and decisions. Notes and decisions are also written into the issue and incident records.'
