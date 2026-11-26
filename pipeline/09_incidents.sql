-- Safety incident lifecycle: Reported -> Made Safe -> Notified -> Under Investigation -> Corrective Actions Open -> Closed.
-- Everything is append-only. A change adds a row (the latest row per id is current) and every action is also written to
-- app_incident_events, so who knew what, and when, can always be shown. Nothing is updated or deleted in place.
-- Configuration (on-call chain, escalation times, regulatory prompts) lives in gold_* tables maintained by the operator.

-- Who is notified when a safety issue is reported, and when an unacknowledged alert escalates.
-- step 1 goes out the moment the report is made. A later step goes out when nobody has acknowledged
-- any earlier step within after_minutes of the report. Demo values; set your own.
CREATE OR REPLACE TABLE workspace.well_ops.gold_incident_oncall (
  step INT, role STRING, channels STRING COMMENT 'Comma list: push, sms, call, teams, email', after_minutes INT COMMENT 'Minutes after the report with no acknowledgement before this step goes out (0 = immediately)',
  reason STRING)
COMMENT 'GOLD. On-call notification chain for safety incidents, with escalation times. Maintained by operations; demo values.';

INSERT INTO workspace.well_ops.gold_incident_oncall VALUES
  (1, 'Field foreman', 'push,sms', 0, 'Coordinates the field response for the area'),
  (1, 'HSE advisor', 'push,sms', 0, 'Owns safety incidents and investigations'),
  (2, 'Production superintendent', 'call,sms', 10, 'Escalation: nobody acknowledged within 10 minutes'),
  (3, 'Field foreman', 'call', 20, 'Second escalation: phone call to the area foreman'),
  (3, 'HSE advisor', 'call', 20, 'Second escalation: phone call to the area HSE advisor');

-- Prompts that a regulatory report MAY be required. They never decide anything: a qualified person
-- (the regulatory coordinator) records the decision. Demo examples only; replace with the operator's
-- own regulator rules for its basin. They are prompts, not legal advice.
CREATE OR REPLACE TABLE workspace.well_ops.gold_reporting_prompts (
  prompt_id STRING, applies_to STRING COMMENT 'Incident category this prompt checks, or * for all',
  min_volume_m3 DOUBLE COMMENT 'Prompt only when the estimated volume is at least this (NULL = any volume)',
  when_injury BOOLEAN COMMENT 'Prompt only when someone was hurt (NULL = not considered)',
  prompt STRING, decided_by_role STRING)
COMMENT 'GOLD. Configurable prompts that a regulatory report may be required. Demo examples, not legal advice; a qualified person decides.';

INSERT INTO workspace.well_ops.gold_reporting_prompts VALUES
  ('RP-SPILL', 'Spill or release', NULL, NULL, 'Releases of produced fluids or hydrocarbons may need to be reported to the regulator, depending on volume, substance and where it went.', 'Regulatory coordinator'),
  ('RP-GAS', 'Gas release', NULL, NULL, 'Uncontrolled gas releases may need to be reported to the regulator.', 'Regulatory coordinator'),
  ('RP-H2S', 'H2S release or alarm', NULL, NULL, 'H2S releases, especially near residences in the emergency planning zone, may need to be reported to the regulator.', 'Regulatory coordinator'),
  ('RP-FIRE', 'Fire or explosion', NULL, NULL, 'Fires and explosions at a wellsite may need to be reported to the regulator.', 'Regulatory coordinator'),
  ('RP-INJURY', '*', NULL, true, 'An injury may need to be reported to the workplace safety authority as well as recorded internally.', 'HSE advisor');

CREATE TABLE IF NOT EXISTS workspace.well_ops.app_safety_incidents (
  incident_id STRING, well_id STRING, area STRING, category STRING, what_happened STRING COMMENT 'As reported, in the reporter''s words',
  people_hurt STRING COMMENT 'Yes, No or Unknown', substance STRING, volume_m3 DOUBLE, occurred_at TIMESTAMP, location STRING,
  state STRING COMMENT 'Reported, Made Safe, Notified, Under Investigation, Corrective Actions Open, Closed',
  made_safe_note STRING, investigation_lead STRING, root_cause STRING, closing_note STRING,
  regulatory_decision STRING COMMENT 'Recorded by a qualified person, never by the app or the AI', regulatory_decided_by STRING,
  source_rule_id STRING COMMENT 'Safety flag the report was raised from, if any',
  reported_by STRING, reported_at TIMESTAMP, updated_by STRING, updated_at TIMESTAMP)
TBLPROPERTIES ('delta.appendOnly' = 'true')
COMMENT 'Safety incidents. Append-only: the latest row per incident_id is the current record.';

CREATE TABLE IF NOT EXISTS workspace.well_ops.app_incident_events (
  event_id STRING, incident_id STRING, at TIMESTAMP, actor STRING COMMENT 'Person, or "Well Watch" for automatic steps',
  action STRING, from_state STRING, to_state STRING, detail STRING, detail_json STRING)
TBLPROPERTIES ('delta.appendOnly' = 'true')
COMMENT 'Audit trail for safety incidents. Insert-only; never updated or deleted.';

CREATE TABLE IF NOT EXISTS workspace.well_ops.app_incident_notifications (
  notification_id STRING, incident_id STRING, step INT, role STRING, person STRING, email STRING, mobile STRING, channels STRING,
  status STRING COMMENT 'Sent or Acknowledged', sent_at TIMESTAMP, acknowledged_at TIMESTAMP, acknowledged_by STRING,
  simulated BOOLEAN COMMENT 'True: recorded, not actually sent (demo)', updated_at TIMESTAMP)
TBLPROPERTIES ('delta.appendOnly' = 'true')
COMMENT 'On-call notifications for safety incidents. Append-only: the latest row per notification_id is current.';

CREATE TABLE IF NOT EXISTS workspace.well_ops.app_corrective_actions (
  action_id STRING, incident_id STRING, description STRING, owner STRING, due_date DATE,
  status STRING COMMENT 'Open or Done', done_note STRING, updated_by STRING, updated_at TIMESTAMP)
TBLPROPERTIES ('delta.appendOnly' = 'true')
COMMENT 'Corrective actions from safety investigations. Append-only: the latest row per action_id is current.'
