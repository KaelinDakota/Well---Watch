-- Production engineers don't record tests or incidents: field and HSE staff do, in their own systems, and those records arrive
-- here read-only (04_safety.sql). What engineers add is context: notes on a well or a flag, optionally "waiting for the official
-- record", which the app confirms automatically when the matching record arrives.
DROP TABLE IF EXISTS workspace.well_ops.app_compliance_entries;

DROP TABLE IF EXISTS workspace.well_ops.app_safety_event_entries;

DROP TABLE IF EXISTS workspace.well_ops.app_event_updates;

CREATE TABLE IF NOT EXISTS workspace.well_ops.app_well_notes (note_id STRING, engineer_id STRING, well_id STRING, rule_id STRING, body STRING,
  pending_kind STRING COMMENT 'test or event when the note reports something not yet in the source system',
  pending_type STRING COMMENT 'test type or event category expected', expected_by DATE, archived BOOLEAN, created_by STRING, created_at TIMESTAMP)
COMMENT 'Engineer notes on wells and flags. Context, not official records. Latest row per note_id wins (archiving writes a new row).';

ALTER TABLE workspace.well_ops.app_flag_acks ADD COLUMNS (owner STRING COMMENT 'Who is handling it (field ops, integrity team, contractor...)');

-- How current each source system is. Received times follow the synthetic feed schedule (SCADA weekly files land Monday 06:00;
-- the maintenance and HSE systems export nightly). data_through is computed from the data itself.
CREATE OR REPLACE TABLE workspace.well_ops.gold_source_freshness
COMMENT 'GOLD. One row per source system: what it provides, latest data date, when it was last received, and how old it may get before it counts as stale.'
AS SELECT * FROM (
  SELECT 'SCADA production' AS source, 'Daily oil, gas, water, hours on, pressures' AS provides,
         (SELECT max(cast(PROD_DATE AS DATE)) FROM workspace.well_ops.bronze_scada_daily) AS data_through,
         (SELECT max(_loaded_at) FROM workspace.well_ops.bronze_scada_daily) AS last_received, 36 AS stale_after_hours, 'bronze_scada_daily' AS bronze_table
  UNION ALL SELECT 'SCADA safety readings', 'Surface casing and flowline pressure, H2S monitors, vented gas',
         (SELECT max(cast(reading_date AS DATE)) FROM workspace.well_ops.bronze_safety_readings), TIMESTAMP'2026-11-23 06:00:00', 36, 'bronze_safety_readings'
  UNION ALL SELECT 'Maintenance / integrity system', 'Tests and inspections; work orders',
         (SELECT max(cast(test_date AS DATE)) FROM workspace.well_ops.bronze_compliance_tests), TIMESTAMP'2026-11-23 05:00:00', 36, 'bronze_compliance_tests'
  UNION ALL SELECT 'HSE incident system', 'Safety events: shutdowns, alarms, spills, releases, regulator findings',
         (SELECT max(cast(event_ts AS DATE)) FROM workspace.well_ops.bronze_safety_events), TIMESTAMP'2026-11-23 05:30:00', 36, 'bronze_safety_events'
  UNION ALL SELECT 'Field downtime log', 'Downtime events and reasons',
         (SELECT max(cast(event_start AS DATE)) FROM workspace.well_ops.bronze_downtime_log), TIMESTAMP'2026-11-23 06:00:00', 36, 'bronze_downtime_log'
  UNION ALL SELECT 'Accounting', 'Monthly operating cost (LOE)',
         (SELECT last_day(max(cast(month AS DATE))) FROM workspace.well_ops.bronze_loe WHERE cast(month AS DATE) < DATE'2026-11-01'), TIMESTAMP'2026-11-10 09:00:00', 1080, 'bronze_loe'
)
