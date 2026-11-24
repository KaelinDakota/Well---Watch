-- Ranking support tables the app writes to: "being handled" acknowledgements, per-well fix cost estimates, and ranking settings.
CREATE TABLE IF NOT EXISTS workspace.well_ops.app_flag_acks (engineer_id STRING, well_id STRING, rule_id STRING, until_date DATE, note STRING,
  snapshot_json STRING, cleared BOOLEAN, acked_by STRING, acked_at TIMESTAMP)
COMMENT 'Flags an engineer marked as being handled. Latest row per engineer, well and rule wins. The flag comes back when until_date passes, when it gets worse than snapshot_json, or when cleared.';

CREATE TABLE IF NOT EXISTS workspace.well_ops.app_fix_estimates (engineer_id STRING, well_id STRING, rule_id STRING, cost_cad DOUBLE, note STRING, entered_by STRING, entered_at TIMESTAMP)
COMMENT 'Engineer estimates of what it would cost to fix a flagged problem on a well (CAD). Overrides the rule default for payback ranking.';

ALTER TABLE workspace.well_ops.app_flag_settings ADD COLUMNS (wo_handled BOOLEAN COMMENT 'Treat wells with an open work order as being handled (production flags only)')
