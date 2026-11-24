-- SILVER: cleaned, conformed, deduplicated. Every rule is recorded in silver_cleaning_rules so the app can show it.
CREATE OR REPLACE TABLE workspace.well_ops.silver_cleaning_rules
COMMENT 'Catalog of the cleaning rules applied between bronze and silver, shown in the lineage view.'
AS SELECT * FROM VALUES
 ('SCADA-DEDUP', 'silver_daily_production', 'If a well-day was sent more than once (late resend), the row from the most recently loaded file wins.'),
 ('SCADA-GAS-UNIT', 'silver_daily_production', 'Gas reported in E3M3 (East field system) is converted to MCF: x 35.3147.'),
 ('SCADA-SENSOR-ERR', 'silver_daily_production', 'Sensor error code -999 is set to null and the row is flagged dq_sensor_error.'),
 ('SCADA-NEGATIVE', 'silver_daily_production', 'Other negative volumes or pressures are set to null and flagged.'),
 ('MASTER-NAMES', 'silver_wells', 'Well names are trimmed and title-cased (e.g. "  KESTREL 3-14H " becomes "Kestrel 3-14H").'),
 ('DOWNTIME-CATEGORY', 'silver_downtime_events', 'Free-text downtime reasons are mapped to a standard category by ai_classify; the original text is kept.'),
 ('DOWNTIME-OPEN', 'silver_downtime_events', 'An event with no hours_lost is an open event (well still down).')
AS t(rule_id, target_table, description);

CREATE OR REPLACE TABLE workspace.well_ops.silver_wells
COMMENT 'SILVER. One row per well: cleaned master data + type curve + responsible engineer.'
AS SELECT m.well_id, m.uwi, regexp_replace(initcap(lower(trim(m.well_name))), '([0-9])h$', '$1H') AS well_name, m.pad, m.area, m.reservoir, m.lift_type,
  to_date(m.on_production_date) AS on_production_date,
  tc.qi_bopd, tc.di_per_year, tc.b_factor, tc.curve_source,
  a.engineer_id, a.engineer_name,
  (m.well_name <> regexp_replace(initcap(lower(trim(m.well_name))), '([0-9])h$', '$1H')) AS name_was_cleaned,
  m._source_file AS _source_file
FROM workspace.well_ops.bronze_well_master m
JOIN workspace.well_ops.bronze_type_curves tc USING (well_id)
JOIN workspace.well_ops.bronze_engineer_assignments a USING (well_id);

CREATE OR REPLACE TABLE workspace.well_ops.silver_daily_production
COMMENT 'SILVER. One row per well per reported day. Deduplicated (latest load wins), gas in MCF, sensor errors nulled. _bronze_id points to the winning bronze row; versions = how many bronze rows existed.'
AS WITH ranked AS (
  SELECT *, row_number() OVER (PARTITION BY UWI_ALIAS, PROD_DATE ORDER BY _loaded_at DESC, _bronze_id) AS rn,
         count(*) OVER (PARTITION BY UWI_ALIAS, PROD_DATE) AS versions
  FROM workspace.well_ops.bronze_scada_daily
)
SELECT UWI_ALIAS AS well_id, PROD_DATE AS prod_date, HRS_ON AS hours_on,
  CASE WHEN OIL_BBL < 0 THEN NULL ELSE OIL_BBL END AS oil_bbl,
  CASE WHEN GAS_VOL < 0 THEN NULL WHEN GAS_UOM = 'E3M3' THEN round(GAS_VOL * 35.3147, 1) ELSE GAS_VOL END AS gas_mcf,
  CASE WHEN WATER_BBL < 0 THEN NULL ELSE WATER_BBL END AS water_bbl,
  CASE WHEN TBG_PSI < 0 THEN NULL ELSE TBG_PSI END AS tubing_psi,
  CASE WHEN CSG_PSI < 0 THEN NULL ELSE CSG_PSI END AS casing_psi,
  (OIL_BBL = -999) AS dq_sensor_error,
  GAS_UOM AS gas_uom_reported, versions,
  filter(array(CASE WHEN versions > 1 THEN 'SCADA-DEDUP' END, CASE WHEN GAS_UOM = 'E3M3' THEN 'SCADA-GAS-UNIT' END,
               CASE WHEN OIL_BBL = -999 THEN 'SCADA-SENSOR-ERR' END,
               CASE WHEN (OIL_BBL < 0 AND OIL_BBL <> -999) OR GAS_VOL < 0 OR WATER_BBL < 0 THEN 'SCADA-NEGATIVE' END), x -> x IS NOT NULL) AS rules_applied,
  _bronze_id, _source_file, _loaded_at
FROM ranked WHERE rn = 1;

CREATE OR REPLACE TABLE workspace.well_ops.silver_downtime_events
COMMENT 'SILVER. Downtime events with AI-standardized category (ai_classify) and the original operator text.'
AS SELECT
  well AS well_id, to_timestamp(event_start) AS event_start, to_date(to_timestamp(event_start)) AS event_date,
  try_cast(hours_lost AS DOUBLE) AS hours_lost, (hours_lost IS NULL) AS is_open, (planned_yn = 'Y') AS planned,
  reason_text AS reason_original,
  ai_classify(reason_text, '{
    "ESP failure": "electric submersible pump tripped, failed or will not restart",
    "Rod pump issue": "rod pump, pumped off, stuffing box, polished rod or pump-off controller problems",
    "Planned work": "planned workover, pump change or planned facility turnaround",
    "Power": "power outage or power bump",
    "Weather": "weather related",
    "Facility / pressure": "high line pressure or facility constraint"}', map('version', '2.0')):response[0]::STRING AS category,
  array('DOWNTIME-CATEGORY') AS rules_applied,
  _bronze_id, _source_file, _loaded_at
FROM workspace.well_ops.bronze_downtime_log;

CREATE OR REPLACE TABLE workspace.well_ops.silver_workorders
COMMENT 'SILVER. Work orders with typed dates.'
AS SELECT wo_number, well_id, wo_type, description, try_to_date(cast(start_date AS STRING)) AS start_date,
  try_to_date(cast(end_date AS STRING)) AS end_date, status, _bronze_id, _source_file
FROM workspace.well_ops.bronze_workorders;

CREATE OR REPLACE TABLE workspace.well_ops.silver_loe
COMMENT 'SILVER. Monthly lease operating expense (CAD) per well.'
AS SELECT well_id, cast(month AS DATE) AS month, cast(loe_cad AS DOUBLE) AS loe_cad, _bronze_id, _source_file
FROM workspace.well_ops.bronze_loe;
