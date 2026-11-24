-- BRONZE: land every source file exactly as received, plus lineage columns.
-- _source_file: file the row came from; _loaded_at: when that file was loaded; _bronze_id: stable row id.
CREATE OR REPLACE TABLE workspace.well_ops.bronze_scada_daily
COMMENT 'BRONZE. Daily SCADA exports exactly as received (weekly files). Includes late resends, sensor error codes (-999) and mixed gas units.'
AS SELECT *,
  _metadata.file_name AS _source_file,
  -- weekly export files are loaded the Monday after the ISO week closes, 06:00
  timestampadd(HOUR, 6, date_add(to_date(concat(substr(_metadata.file_name, 14, 4), '-01-04')),
     (cast(substr(_metadata.file_name, 20, 2) AS INT) - 1) * 7 + 7 - (dayofweek(to_date(concat(substr(_metadata.file_name, 14, 4), '-01-04'))) + 5) % 7)) AS _loaded_at,
  substr(sha2(concat_ws('|', _metadata.file_name, UWI_ALIAS, PROD_DATE, HRS_ON, OIL_BBL, GAS_VOL, WATER_BBL, TBG_PSI, CSG_PSI), 256), 1, 12) AS _bronze_id
FROM read_files('/Volumes/workspace/well_ops/landing/scada/', format => 'csv', header => true, inferSchema => true);

CREATE OR REPLACE TABLE workspace.well_ops.bronze_downtime_log
COMMENT 'BRONZE. Field downtime logs (monthly files), free-text reasons as typed by operators.'
AS SELECT *, _metadata.file_name AS _source_file, _metadata.file_modification_time AS _loaded_at,
  substr(sha2(concat_ws('|', _metadata.file_name, well, event_start, reason_text), 256), 1, 12) AS _bronze_id
FROM read_files('/Volumes/workspace/well_ops/landing/downtime/', format => 'csv', header => true, inferSchema => true);

CREATE OR REPLACE TABLE workspace.well_ops.bronze_workorders
COMMENT 'BRONZE. Maintenance system work order extract.'
AS SELECT *, _metadata.file_name AS _source_file, _metadata.file_modification_time AS _loaded_at,
  substr(sha2(concat_ws('|', wo_number, well_id), 256), 1, 12) AS _bronze_id
FROM read_files('/Volumes/workspace/well_ops/landing/maintenance/', format => 'csv', header => true, inferSchema => true);

CREATE OR REPLACE TABLE workspace.well_ops.bronze_loe
COMMENT 'BRONZE. Monthly lease operating expense by well from accounting (CAD).'
AS SELECT *, _metadata.file_name AS _source_file, _metadata.file_modification_time AS _loaded_at,
  substr(sha2(concat_ws('|', well_id, month), 256), 1, 12) AS _bronze_id
FROM read_files('/Volumes/workspace/well_ops/landing/economics/', format => 'csv', header => true, inferSchema => true);

CREATE OR REPLACE TABLE workspace.well_ops.bronze_well_master
COMMENT 'BRONZE. Well master extract (names not cleaned).'
AS SELECT *, _metadata.file_name AS _source_file, _metadata.file_modification_time AS _loaded_at
FROM read_files('/Volumes/workspace/well_ops/landing/master/well_master.csv', format => 'csv', header => true, inferSchema => true);

CREATE OR REPLACE TABLE workspace.well_ops.bronze_type_curves
COMMENT 'BRONZE. Reservoir engineering type curve parameters per well (Arps).'
AS SELECT *, _metadata.file_name AS _source_file, _metadata.file_modification_time AS _loaded_at
FROM read_files('/Volumes/workspace/well_ops/landing/master/type_curves.csv', format => 'csv', header => true, inferSchema => true);

CREATE OR REPLACE TABLE workspace.well_ops.bronze_engineer_assignments
COMMENT 'BRONZE. Which production engineer is responsible for each well.'
AS SELECT *, _metadata.file_name AS _source_file, _metadata.file_modification_time AS _loaded_at
FROM read_files('/Volumes/workspace/well_ops/landing/master/engineer_assignments.csv', format => 'csv', header => true, inferSchema => true);
