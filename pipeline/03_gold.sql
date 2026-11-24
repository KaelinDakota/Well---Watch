-- GOLD: business-ready facts. Every gold row keeps the keys needed to trace back to silver and bronze.
CREATE OR REPLACE TABLE workspace.well_ops.gold_price_assumptions
COMMENT 'GOLD. Price and cost assumptions used in economics (single source of truth).'
AS SELECT * FROM VALUES ('oil_price_cad_bbl', 75.0, 'Realized oil price, CAD/bbl'), ('gas_price_cad_mcf', 2.5, 'Realized gas price, CAD/mcf'),
  ('royalty_rate', 0.15, 'Average Crown/freehold royalty'), ('transport_cad_boe', 3.0, 'Trucking/pipeline tariff, CAD/boe')
AS t(assumption, value, description);

CREATE OR REPLACE TABLE workspace.well_ops.gold_well_dim
COMMENT 'GOLD. Conformed well dimension with responsible engineer.'
AS SELECT well_id, well_name, uwi, pad, area, reservoir, lift_type, on_production_date, engineer_id, engineer_name,
  qi_bopd, di_per_year, b_factor, curve_source FROM workspace.well_ops.silver_wells;

CREATE OR REPLACE TABLE workspace.well_ops.gold_daily_well
COMMENT 'GOLD. One row per well per calendar day (May 27 - Nov 22, 2026). reported=false means no SCADA row arrived. target_oil_bopd is the Arps type curve: qi / (1 + b*Di*t)^(1/b), t in years since on-production. Key (well_id, prod_date) links to silver_daily_production.'
AS WITH spine AS (
  SELECT w.well_id, d AS prod_date, w.qi_bopd, w.di_per_year, w.b_factor, w.on_production_date
  FROM workspace.well_ops.gold_well_dim w LATERAL VIEW explode(sequence(DATE'2026-05-27', DATE'2026-11-22')) x AS d
)
SELECT s.well_id, s.prod_date, (p.well_id IS NOT NULL) AS reported,
  p.hours_on, p.oil_bbl, p.gas_mcf, p.water_bbl, p.tubing_psi, p.casing_psi,
  round(s.qi_bopd / power(1 + s.b_factor * s.di_per_year * datediff(s.prod_date, s.on_production_date) / 365.0, 1 / s.b_factor), 1) AS target_oil_bopd,
  round(p.hours_on / 24, 3) AS uptime,
  CASE WHEN p.oil_bbl + p.water_bbl > 0 THEN round(p.water_bbl / (p.oil_bbl + p.water_bbl), 4) END AS water_cut,
  CASE WHEN p.oil_bbl > 0 THEN round(p.gas_mcf * 1000 / p.oil_bbl, 0) END AS gor_scf_bbl,
  coalesce(p.dq_sensor_error, false) AS dq_sensor_error
FROM spine s LEFT JOIN workspace.well_ops.silver_daily_production p ON p.well_id = s.well_id AND p.prod_date = s.prod_date;

CREATE OR REPLACE TABLE workspace.well_ops.gold_downtime_events
COMMENT 'GOLD. Downtime events with standardized category and engineer. Links to silver_downtime_events by _bronze_id.'
AS SELECT e.*, w.engineer_id, w.well_name FROM workspace.well_ops.silver_downtime_events e JOIN workspace.well_ops.gold_well_dim w USING (well_id);

CREATE OR REPLACE TABLE workspace.well_ops.gold_monthly_economics
COMMENT 'GOLD. Monthly economics per well. boe = oil + gas/6. netback = (oil*price + gas*price)*(1-royalty) - transport*boe. margin = netback - LOE.'
AS WITH a AS (SELECT max(CASE WHEN assumption = 'oil_price_cad_bbl' THEN value END) op, max(CASE WHEN assumption = 'gas_price_cad_mcf' THEN value END) gp,
                     max(CASE WHEN assumption = 'royalty_rate' THEN value END) rr, max(CASE WHEN assumption = 'transport_cad_boe' THEN value END) tr
              FROM workspace.well_ops.gold_price_assumptions),
m AS (SELECT well_id, trunc(prod_date, 'MM') AS month, sum(oil_bbl) oil_bbl, sum(gas_mcf) gas_mcf, count_if(reported) AS days_reported
      FROM workspace.well_ops.gold_daily_well GROUP BY 1, 2)
SELECT m.well_id, m.month, m.days_reported, round(m.oil_bbl, 0) AS oil_bbl, round(m.gas_mcf, 0) AS gas_mcf,
  round(m.oil_bbl + m.gas_mcf / 6, 0) AS boe,
  round((m.oil_bbl * a.op + m.gas_mcf * a.gp) * (1 - a.rr) - a.tr * (m.oil_bbl + m.gas_mcf / 6), 0) AS netback_cad,
  l.loe_cad,
  round((m.oil_bbl * a.op + m.gas_mcf * a.gp) * (1 - a.rr) - a.tr * (m.oil_bbl + m.gas_mcf / 6) - l.loe_cad, 0) AS operating_margin_cad,
  round(((m.oil_bbl * a.op + m.gas_mcf * a.gp) * (1 - a.rr) - a.tr * (m.oil_bbl + m.gas_mcf / 6)) / nullif(m.oil_bbl + m.gas_mcf / 6, 0), 2) AS netback_per_boe,
  round(l.loe_cad / nullif(m.oil_bbl + m.gas_mcf / 6, 0), 2) AS loe_per_boe
FROM m CROSS JOIN a LEFT JOIN workspace.well_ops.silver_loe l ON l.well_id = m.well_id AND l.month = m.month;

-- Snapshot as of the last data day (2026-11-22): every fact a flag can test, per well.
-- Recent window = last 7 days (Nov 16-22). Baseline = 30 days ending 2 weeks earlier (Oct 10 - Nov 8).
CREATE OR REPLACE TABLE workspace.well_ops.gold_well_snapshot
COMMENT 'GOLD. One row per well with the latest condition (as of 2026-11-22). Recent = Nov 16-22, baseline = Oct 10 - Nov 8. Performance ratio compares oil to type curve on producing hours only. value_at_risk_cad_day = lost oil vs type curve x oil netback per bbl.'
AS WITH d AS (SELECT * FROM workspace.well_ops.gold_daily_well),
win AS (
  SELECT well_id,
    sum(CASE WHEN prod_date >= '2026-11-16' AND reported AND hours_on > 0 THEN oil_bbl END) / sum(CASE WHEN prod_date >= '2026-11-16' AND reported AND hours_on > 0 THEN target_oil_bopd * uptime END) AS perf_ratio_7d,
    sum(CASE WHEN prod_date BETWEEN '2026-10-10' AND '2026-11-08' AND reported AND hours_on > 0 THEN oil_bbl END) / sum(CASE WHEN prod_date BETWEEN '2026-10-10' AND '2026-11-08' AND reported AND hours_on > 0 THEN target_oil_bopd * uptime END) AS perf_ratio_baseline,
    avg(CASE WHEN prod_date >= '2026-11-16' AND reported THEN oil_bbl END) AS oil_7d_bopd,
    avg(CASE WHEN prod_date >= '2026-11-16' AND reported THEN target_oil_bopd END) AS target_7d_bopd,
    sum(CASE WHEN prod_date >= '2026-11-16' AND reported THEN water_bbl END) / nullif(sum(CASE WHEN prod_date >= '2026-11-16' AND reported THEN oil_bbl + water_bbl END), 0) AS water_cut_7d,
    sum(CASE WHEN prod_date BETWEEN '2026-10-10' AND '2026-11-08' AND reported THEN water_bbl END) / nullif(sum(CASE WHEN prod_date BETWEEN '2026-10-10' AND '2026-11-08' AND reported THEN oil_bbl + water_bbl END), 0) AS water_cut_baseline,
    sum(CASE WHEN prod_date >= '2026-11-16' AND reported THEN gas_mcf END) * 1000 / nullif(sum(CASE WHEN prod_date >= '2026-11-16' AND reported THEN oil_bbl END), 0) AS gor_7d,
    sum(CASE WHEN prod_date BETWEEN '2026-10-10' AND '2026-11-08' AND reported THEN gas_mcf END) * 1000 / nullif(sum(CASE WHEN prod_date BETWEEN '2026-10-10' AND '2026-11-08' AND reported THEN oil_bbl END), 0) AS gor_baseline,
    avg(CASE WHEN prod_date >= '2026-11-16' AND reported THEN casing_psi END) AS casing_psi_7d,
    avg(CASE WHEN prod_date BETWEEN '2026-10-10' AND '2026-11-08' AND reported THEN casing_psi END) AS casing_psi_baseline,
    avg(CASE WHEN prod_date >= '2026-11-09' AND reported THEN uptime END) AS uptime_14d,
    max(CASE WHEN reported THEN prod_date END) AS last_reported_date,
    max(CASE WHEN reported AND hours_on > 0 THEN prod_date END) AS last_producing_date
  FROM d GROUP BY well_id
),
ev AS (
  SELECT well_id, count_if(event_date >= '2026-11-09' AND NOT planned) AS downtime_events_14d,
    max_by(category, CASE WHEN is_open THEN event_start END) AS open_event_category,
    max_by(reason_original, CASE WHEN is_open THEN event_start END) AS open_event_reason,
    max_by(planned, CASE WHEN is_open THEN event_start END) AS open_event_planned,
    max(CASE WHEN is_open THEN event_date END) AS open_event_date
  FROM workspace.well_ops.silver_downtime_events GROUP BY well_id
),
wo AS (
  SELECT well_id, min(datediff(DATE'2026-11-22', CASE WHEN status = 'Closed' THEN end_date END)) AS days_since_workover,
    count_if(status <> 'Closed') AS open_work_orders, max_by(CASE WHEN status <> 'Closed' THEN wo_number || ' ' || description END, wo_number) AS open_work_order
  FROM workspace.well_ops.silver_workorders GROUP BY well_id
),
ec AS (SELECT well_id, netback_per_boe, loe_per_boe, round(netback_per_boe - loe_per_boe, 2) AS margin_per_boe, operating_margin_cad
       FROM workspace.well_ops.gold_monthly_economics WHERE month = DATE'2026-10-01'),
oilnb AS (SELECT max(CASE WHEN assumption = 'oil_price_cad_bbl' THEN value END) * (1 - max(CASE WHEN assumption = 'royalty_rate' THEN value END)) - max(CASE WHEN assumption = 'transport_cad_boe' THEN value END) AS oil_netback
          FROM workspace.well_ops.gold_price_assumptions)
SELECT g.well_id, g.well_name, g.engineer_id, g.engineer_name, g.reservoir, g.lift_type, g.area, g.pad,
  DATE'2026-11-22' AS as_of_date,
  round(w.oil_7d_bopd, 1) AS oil_7d_bopd, round(w.target_7d_bopd, 1) AS target_7d_bopd,
  round(w.perf_ratio_7d, 3) AS perf_ratio_7d, round(w.perf_ratio_baseline, 3) AS perf_ratio_baseline,
  round((w.water_cut_7d - w.water_cut_baseline) * 100, 1) AS water_cut_change_pts, round(w.water_cut_7d * 100, 1) AS water_cut_7d_pct,
  round(w.gor_7d, 0) AS gor_7d, round(100 * (w.gor_7d - w.gor_baseline) / nullif(w.gor_baseline, 0), 1) AS gor_change_pct,
  round(w.casing_psi_7d, 0) AS casing_psi_7d, round(w.casing_psi_7d - w.casing_psi_baseline, 0) AS casing_psi_change,
  round(w.uptime_14d * 100, 1) AS uptime_14d_pct,
  w.last_reported_date, datediff(DATE'2026-11-22', w.last_reported_date) AS days_since_last_data,
  CASE WHEN w.last_reported_date > coalesce(w.last_producing_date, DATE'1900-01-01') THEN datediff(w.last_reported_date, w.last_producing_date) ELSE 0 END AS consecutive_down_days,
  coalesce(ev.downtime_events_14d, 0) AS downtime_events_14d,
  ev.open_event_category, ev.open_event_reason, coalesce(ev.open_event_planned, false) AS open_event_planned, ev.open_event_date,
  wo.days_since_workover, coalesce(wo.open_work_orders, 0) AS open_work_orders, wo.open_work_order,
  ec.netback_per_boe, ec.loe_per_boe, ec.margin_per_boe, ec.operating_margin_cad AS operating_margin_oct_cad,
  round(greatest(w.target_7d_bopd - w.oil_7d_bopd, 0), 1) AS lost_oil_bopd,
  round(greatest(w.target_7d_bopd - w.oil_7d_bopd, 0) * oilnb.oil_netback, 0) AS value_at_risk_cad_day
FROM workspace.well_ops.gold_well_dim g
JOIN win w USING (well_id) LEFT JOIN ev USING (well_id) LEFT JOIN wo USING (well_id) LEFT JOIN ec USING (well_id) CROSS JOIN oilnb;
