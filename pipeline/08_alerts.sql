-- Agent alert workflow: who to tell about a flagged well, and the follow-up tasks the alerts create.
-- Contacts are synthetic (an HR / field directory export). Phone numbers use the reserved 555-01xx range.

CREATE OR REPLACE TABLE workspace.well_ops.bronze_contact_directory (
  employee_id STRING, full_name STRING, role STRING, area STRING COMMENT 'Operating area covered; NULL = all areas',
  email STRING, mobile STRING, teams_upn STRING, _loaded_at TIMESTAMP, _source_file STRING)
COMMENT 'BRONZE. Field and HSE directory export: who holds which role for which area. Synthetic.';

INSERT INTO workspace.well_ops.bronze_contact_directory VALUES
  ('E-2101', 'Travis Kowalchuk', 'Field foreman', 'North', 'travis.kowalchuk@ridgeline.example', '+1 403 555 0141', 'travis.kowalchuk@ridgeline.example', TIMESTAMP'2026-11-23 05:00:00', 'directory_2026-11-23.csv'),
  ('E-2102', 'Renee Lafleur', 'Field foreman', 'South', 'renee.lafleur@ridgeline.example', '+1 403 555 0142', 'renee.lafleur@ridgeline.example', TIMESTAMP'2026-11-23 05:00:00', 'directory_2026-11-23.csv'),
  ('E-2103', 'Dale Sorensen', 'Field foreman', 'East', 'dale.sorensen@ridgeline.example', '+1 403 555 0143', 'dale.sorensen@ridgeline.example', TIMESTAMP'2026-11-23 05:00:00', 'directory_2026-11-23.csv'),
  ('E-2104', 'Kim Nakamura', 'Field foreman', 'West', 'kim.nakamura@ridgeline.example', '+1 403 555 0144', 'kim.nakamura@ridgeline.example', TIMESTAMP'2026-11-23 05:00:00', 'directory_2026-11-23.csv'),
  ('E-2201', 'Amara Okafor', 'HSE advisor', 'North', 'amara.okafor@ridgeline.example', '+1 403 555 0151', 'amara.okafor@ridgeline.example', TIMESTAMP'2026-11-23 05:00:00', 'directory_2026-11-23.csv'),
  ('E-2201', 'Amara Okafor', 'HSE advisor', 'West', 'amara.okafor@ridgeline.example', '+1 403 555 0151', 'amara.okafor@ridgeline.example', TIMESTAMP'2026-11-23 05:00:00', 'directory_2026-11-23.csv'),
  ('E-2202', 'Brent Halvorsen', 'HSE advisor', 'East', 'brent.halvorsen@ridgeline.example', '+1 403 555 0152', 'brent.halvorsen@ridgeline.example', TIMESTAMP'2026-11-23 05:00:00', 'directory_2026-11-23.csv'),
  ('E-2202', 'Brent Halvorsen', 'HSE advisor', 'South', 'brent.halvorsen@ridgeline.example', '+1 403 555 0152', 'brent.halvorsen@ridgeline.example', TIMESTAMP'2026-11-23 05:00:00', 'directory_2026-11-23.csv'),
  ('E-2301', 'Sofia Marchetti', 'Well integrity engineer', NULL, 'sofia.marchetti@ridgeline.example', '+1 403 555 0161', 'sofia.marchetti@ridgeline.example', TIMESTAMP'2026-11-23 05:00:00', 'directory_2026-11-23.csv'),
  ('E-2302', 'Jordan Pelletier', 'Artificial lift specialist', NULL, 'jordan.pelletier@ridgeline.example', '+1 403 555 0162', 'jordan.pelletier@ridgeline.example', TIMESTAMP'2026-11-23 05:00:00', 'directory_2026-11-23.csv'),
  ('E-2303', 'Cheryl Bouchard', 'Maintenance planner', NULL, 'cheryl.bouchard@ridgeline.example', '+1 403 555 0163', 'cheryl.bouchard@ridgeline.example', TIMESTAMP'2026-11-23 05:00:00', 'directory_2026-11-23.csv'),
  ('E-2304', 'Victor Mbeki', 'Regulatory coordinator', NULL, 'victor.mbeki@ridgeline.example', '+1 403 555 0164', 'victor.mbeki@ridgeline.example', TIMESTAMP'2026-11-23 05:00:00', 'directory_2026-11-23.csv'),
  ('E-2305', 'Laura Fitzgerald', 'Production superintendent', NULL, 'laura.fitzgerald@ridgeline.example', '+1 403 555 0165', 'laura.fitzgerald@ridgeline.example', TIMESTAMP'2026-11-23 05:00:00', 'directory_2026-11-23.csv');

CREATE OR REPLACE TABLE workspace.well_ops.silver_contacts
COMMENT 'SILVER. Cleaned contact directory: one row per person, role and area covered (NULL area = all areas).'
AS SELECT employee_id, trim(full_name) AS full_name, trim(role) AS role, area, lower(email) AS email, mobile, lower(teams_upn) AS teams_upn
FROM workspace.well_ops.bronze_contact_directory;

-- Who to notify for each kind of flag. First matching row wins: rule, then group, then category, then default.
-- roles: in order; the first role owns the follow-up task.
CREATE OR REPLACE TABLE workspace.well_ops.gold_alert_routing (
  match_type STRING, match_value STRING, roles STRING, reason STRING, priority INT)
COMMENT 'GOLD. Alert routing: which roles hear about which flags, and why. Maintained by operations; synthetic.';

INSERT INTO workspace.well_ops.gold_alert_routing VALUES
  ('rule', 'SAFE_NONCOMPLIANCE', 'Regulatory coordinator,HSE advisor', 'Open regulator findings have response deadlines', 1),
  ('rule', 'SAFE_FLOWLINE_MAOP', 'Well integrity engineer,Field foreman', 'Flowline pressure near its maximum allowed operating pressure', 1),
  ('rule', 'SAFE_PSV_LIFT', 'Field foreman,HSE advisor', 'A relief valve lifted: overpressure reached the wellsite', 1),
  ('rule', 'SAFE_ELECTRICAL', 'Field foreman,Artificial lift specialist', 'Open electrical fault on lift equipment', 1),
  ('rule', 'SAFE_ESD_TRIPS', 'Field foreman,HSE advisor', 'Repeated emergency shutdowns', 1),
  ('rule', 'SAFE_VENT_LIMIT', 'Regulatory coordinator,Field foreman', 'Venting above the monthly regulatory limit', 1),
  ('rule', 'SAFE_WALL_LOSS', 'Well integrity engineer', 'Corrosion wall loss needs an integrity assessment', 1),
  ('rule', 'SAFE_INACTIVE', 'Regulatory coordinator', 'Inactive well obligations', 1),
  ('group', 'H2S at surface', 'HSE advisor,Field foreman', 'Possible H2S exposure at the wellsite', 2),
  ('group', 'Production casing pressure', 'Well integrity engineer,Field foreman', 'Casing pressure is a well integrity concern', 2),
  ('group', 'Well integrity: vent flow / failed tests', 'Well integrity engineer,Field foreman,Regulatory coordinator', 'Integrity failures can be reportable', 2),
  ('group', 'Releases', 'HSE advisor,Field foreman,Regulatory coordinator', 'Releases and spills are reportable', 2),
  ('group', 'Tests due', 'Maintenance planner,Well integrity engineer', 'Tests are scheduled through maintenance', 2),
  ('group', 'Downtime', 'Field foreman,Artificial lift specialist', 'Well is down; the field crew and lift specialist restore it', 2),
  ('category', 'Performance', 'Artificial lift specialist', 'Production performance and lift optimization', 3),
  ('category', 'Economics', 'Production superintendent', 'Operating cost decisions', 3),
  ('category', 'Safety', 'HSE advisor,Field foreman', 'Safety issue at the wellsite', 3),
  ('default', '*', 'Field foreman', 'The field crew checks the well', 4);

CREATE OR REPLACE VIEW workspace.well_ops.gold_well_contacts
COMMENT 'GOLD. For every well, who holds each role (by the well''s area), plus the well''s production engineer.'
AS SELECT d.well_id, c.role, c.full_name, c.email, c.mobile, c.teams_upn, c.employee_id
FROM workspace.well_ops.gold_well_dim d JOIN workspace.well_ops.silver_contacts c ON c.area = d.area OR c.area IS NULL
UNION ALL
SELECT d.well_id, 'Production engineer', d.engineer_name, lower(replace(d.engineer_name, ' ', '.')) || '@ridgeline.example', NULL,
       lower(replace(d.engineer_name, ' ', '.')) || '@ridgeline.example', d.engineer_id
FROM workspace.well_ops.gold_well_dim d;

CREATE TABLE IF NOT EXISTS workspace.well_ops.app_alert_tasks (
  task_id STRING, engineer_id STRING, well_id STRING, rule_id STRING, rule_name STRING, severity STRING,
  owner_name STRING, owner_role STRING, owner_email STRING, due_date DATE, status STRING COMMENT 'Open, Done or Cancelled',
  recipients_json STRING, drafts_json STRING COMMENT 'The approved email, Teams and text messages', checks_json STRING COMMENT 'Checker results at approval',
  simulated BOOLEAN COMMENT 'True when raised from a demo simulated reading', status_note STRING, created_by STRING, created_at TIMESTAMP)
COMMENT 'Follow-up tasks created when an engineer approves an alert drafted by Greg. Latest row per task_id wins.'
