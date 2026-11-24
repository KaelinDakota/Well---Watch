"""Our own production-engineering chat agent.

The model (a Databricks-hosted foundation model) can only learn facts by calling the tools below. Every tool call
is stored as an evidence record (layer, table, the SQL, the rows). The model must cite evidence IDs like [E3].
After the answer, verify() checks each citation exists and that every number in a cited sentence appears in that
evidence, so unsupported numbers are flagged to the user.
"""
import json, re, time, uuid

MAX_ROWS_TO_MODEL = 40
ID_RE = re.compile(r"\[(E\d+(?:\s*,\s*E\d+)*)\]")


class Conversation:
    def __init__(self):
        self.id = uuid.uuid4().hex[:12]
        self.messages = []          # text-only history for the model
        self.evidence = {}          # E# -> record
        self.n = 0
        self.touched = time.time()

    def add_evidence(self, rec):
        self.n += 1
        rec["id"] = f"E{self.n}"
        self.evidence[rec["id"]] = rec
        return rec["id"]


SYSTEM = """You are the production engineering assistant for a portfolio of oil wells (synthetic demo data).
Today is 2026-11-23. Daily data runs from 2026-05-27 to 2026-11-22 (yesterday).
Rules:
1. Learn every fact from the tools, and call at least one tool for EVERY question, even simple ones: get_definitions for what a term means, get_my_rules for how flags and ranking work, data tools for anything about wells. Never guess or use outside knowledge about these wells. If the tools don't show it, say "The data doesn't show that."
2. Every tool result has an evidence_id. End EVERY sentence or bullet that states a fact with the evidence id(s) it came from, written exactly like [E2] or [E2, E5] (plain square brackets). Only cite ids you received from tools in this conversation; call a tool before you cite it.
3. Copy numbers exactly as the tools give them, with units (bbl/d, psi, %, $/day). Use the summary figures tools provide instead of doing your own arithmetic. Every bullet with a number needs a citation.
4. The ranking comes from the engineer's own flag rules, in tiers: "safety" (Critical/Warning safety flags, by severity), then "production" (by $/day at risk, fastest payback or points, per the engineer's setting), then "watch" (Review-only flags); "handled" wells were marked as being handled and are out of the top 10. Related rules count once. Say so when you explain why a well ranks where it does.
5. Tests come from the maintenance / integrity system and safety events from the HSE incident system; engineers don't record them in this app. Engineer notes (get_well_notes) are context, not official records: say so when you use one. Safety: use get_safety_status, get_tests_and_inspections and get_safety_events for integrity, H2S, pressure limits, tests, spills, releases and regulator items. Safety flags rank first when the engineer's "safety first" setting is on. For any general question about safety issues, FIRST call get_ranked_wells and report every well whose safety_flag is Critical or Warning with its safety flag messages; then add open events or overdue tests if relevant. You don't make safety, shut-in or reporting decisions: give the evidence and the suggested next step, and say to follow company procedures and the regulator's requirements.
6. Be concise: under 180 words. Plain sentences or "- " bullets. No tables, no headings."""


def tool_specs():
    s = lambda props, req=(): {"type": "object", "properties": props, "required": list(req)}
    wid = {"well_id": {"type": "string", "description": "e.g. W-007"}}
    return [
        {"name": "get_ranked_wells", "description": "Today's ranked list of wells needing attention for the current engineer, produced by their flag rules: rank, tier (safety / production / watch / handled), points, $/day at risk, fix cost and payback days, and each flag with its message and whether it is marked as being handled.", "parameters": s({})},
        {"name": "get_well_snapshot", "description": "Latest condition of one well as of yesterday: rates vs type curve, water cut, GOR, casing pressure, uptime, downtime, economics, value at risk.", "parameters": s(wid, ["well_id"])},
        {"name": "get_production_history", "description": "Daily production rows for one well: oil, type-curve target, hours on, water cut, GOR, pressures.", "parameters": s({**wid, "days": {"type": "integer", "description": "how many days back from yesterday (default 14, max 60)"}}, ["well_id"])},
        {"name": "get_downtime_events", "description": "Downtime events for one well: date, standardized category, operator's original text, hours lost, planned or not, still open.", "parameters": s({**wid, "days": {"type": "integer", "description": "days back (default 60)"}}, ["well_id"])},
        {"name": "get_economics", "description": "Monthly economics for one well: oil, gas, boe, netback, operating cost, margin.", "parameters": s(wid, ["well_id"])},
        {"name": "get_work_orders", "description": "Work orders for one well (open and closed).", "parameters": s(wid, ["well_id"])},
        {"name": "find_wells", "description": "Search wells in the portfolio by engineer, reservoir, lift type or area, sorted by a snapshot field.",
         "parameters": s({"engineer_id": {"type": "string", "description": "ENG-1..ENG-4"}, "reservoir": {"type": "string"}, "lift_type": {"type": "string"}, "area": {"type": "string"},
                          "sort_by": {"type": "string", "enum": ["value_at_risk_cad_day", "perf_ratio_7d", "water_cut_change_pts", "gor_change_pct", "casing_psi_change", "downtime_events_14d", "margin_per_boe", "oil_7d_bopd"]},
                          "ascending": {"type": "boolean"}, "limit": {"type": "integer"}})},
        {"name": "get_safety_status", "description": "Safety picture for one well: sour class and H2S, EPZ, casing pressure vs MAASP, surface casing pressure and vent flow status, flowline pressure vs MAOP, venting vs limit, counts of overdue / failed tests and open / unreported safety events.", "parameters": s(wid, ["well_id"])},
        {"name": "get_tests_and_inspections", "description": "Tests and inspections (latest of each type): type, group, safety-critical, last date, result, next due date, days until due / overdue. For one well, or for the current engineer's wells when well_id is omitted.",
         "parameters": s({**wid, "only": {"type": "string", "enum": ["all", "overdue", "due_30d", "failed"], "description": "filter (default all for one well, overdue for the portfolio)"}})},
        {"name": "get_safety_events", "description": "Safety events (ESD trips, PSV lifts, H2S alarms, spills, gas releases, electrical faults, regulator non-compliance, near misses): date, category, status, reportable / reported. For one well, or the current engineer's wells when well_id is omitted.",
         "parameters": s({**wid, "days": {"type": "integer", "description": "days back (default 90)"}, "open_only": {"type": "boolean"}})},
        {"name": "get_definitions", "description": "Plain-language definitions of oil and gas terms and Well Watch concepts (e.g. MAASP, type curve, water cut, SCVF, EPZ, points, tiers, payback, being handled).",
         "parameters": s({"terms": {"type": "array", "items": {"type": "string"}, "description": "terms to look up; partial words are fine"}}, ["terms"])},
        {"name": "get_my_rules", "description": "The current engineer's flag rules and ranking settings: each rule's conditions, severity, points, group, fix cost and whether it is on.", "parameters": s({})},
        {"name": "get_well_notes", "description": "Notes engineers wrote on a well (context such as 'operator says the monitor is faulty', or reports waiting for the official record). Notes are not official records.",
         "parameters": s(wid, ["well_id"])},
        {"name": "portfolio_summary", "description": "Totals for an engineer's wells (or all wells): well count, oil vs type curve last 7 days, wells down, value at risk.",
         "parameters": s({"engineer_id": {"type": "string", "description": "ENG-1..ENG-4; defaults to the current engineer; ALL for every well"}})},
    ]


class Tools:
    """SQL-backed tools. query(sql, params) -> list of dicts. Each call returns (evidence_record, model_payload)."""
    def __init__(self, query, schema):
        self.q, self.S = query, schema

    def _ev(self, conv, tool, layer, table, sql, params, rows, title, keys):
        shown = sql
        for k, v in params.items(): shown = shown.replace(":" + k, repr(str(v)))
        eid = conv.add_evidence({"tool": tool, "layer": layer, "table": table, "tables": [t.strip() for t in table.split("+")], "sql": " ".join(shown.split()), "title": title,
                                 "rows": rows[:200], "row_count": len(rows), "keys": keys})
        return eid

    def run(self, conv, name, args, ctx):
        S = self.S
        well = (args.get("well_id") or "").strip().upper()
        if well and not re.fullmatch(r"W-\d{3}", well): return {"error": "well_id must look like W-007"}
        if name == "get_ranked_wells":
            rows = ctx.get("ranking") or []
            eid = self._ev(conv, name, "gold + your flag rules", f"{S}.gold_well_snapshot + {S}.gold_v_well_safety + {S}.gold_v_compliance_items + {S}.gold_v_safety_events + {S}.app_flag_rules",
                           "Ranking computed in the app (flags.js) from the gold snapshot, safety views, tests and events, using your saved flag rules", {}, rows,
                           f"Today's ranking for {ctx.get('engineer_name', 'all engineers')}", ["well_id"])
            return {"evidence_id": eid, "engineer": ctx.get("engineer_name"), "wells": rows[:MAX_ROWS_TO_MODEL]}
        if name == "get_well_snapshot":
            sql = f"SELECT * FROM {S}.gold_well_snapshot WHERE well_id = :w"
            rows = self.q(sql, {"w": well})
            if not rows: return {"error": f"no well {well}"}
            eid = self._ev(conv, name, "gold", f"{S}.gold_well_snapshot", sql, {"w": well}, rows, f"{well} snapshot as of 2026-11-22", ["well_id"])
            return {"evidence_id": eid, "snapshot": rows[0]}
        if name == "get_production_history":
            days = max(1, min(int(args.get("days") or 14), 60))
            sql = f"""SELECT well_id, prod_date, reported, hours_on, oil_bbl, target_oil_bopd, water_bbl, gas_mcf, water_cut, gor_scf_bbl, tubing_psi, casing_psi
                      FROM {S}.gold_daily_well WHERE well_id = :w AND prod_date > date_sub(DATE'2026-11-22', :d) ORDER BY prod_date"""
            rows = self.q(sql, {"w": well, "d": days})
            rep = [r for r in rows if r.get("reported")]
            prod = [r for r in rep if (r.get("hours_on") or 0) > 0]
            avg = lambda xs: round(sum(xs) / len(xs), 1) if xs else None
            summary = {"days_in_window": len(rows), "days_reported": len(rep), "days_producing": len(prod),
                       "avg_oil_bopd": avg([r["oil_bbl"] or 0 for r in rep]), "avg_type_curve_bopd": avg([r["target_oil_bopd"] for r in rep]),
                       "total_oil_bbl": round(sum((r["oil_bbl"] or 0) for r in rep), 1), "total_type_curve_bbl": round(sum(r["target_oil_bopd"] for r in rep), 1),
                       "avg_water_cut_pct": avg([100 * r["water_cut"] for r in rep if r.get("water_cut") is not None]),
                       "avg_gor_scf_bbl": avg([r["gor_scf_bbl"] for r in rep if r.get("gor_scf_bbl")]),
                       "avg_casing_psi": avg([r["casing_psi"] for r in rep if r.get("casing_psi") is not None])}
            if summary["avg_oil_bopd"] is not None and summary["avg_type_curve_bopd"]:
                summary["oil_vs_type_curve_pct"] = round(100 * summary["avg_oil_bopd"] / summary["avg_type_curve_bopd"], 1)
                summary["shortfall_bopd"] = round(summary["avg_type_curve_bopd"] - summary["avg_oil_bopd"], 1)
                summary["below_type_curve_pct"] = round(100 - summary["oil_vs_type_curve_pct"], 1)
            eid = self._ev(conv, name, "gold", f"{S}.gold_daily_well", sql, {"w": well, "d": days}, rows, f"{well} daily production, last {days} days", ["well_id", "prod_date"])
            conv.evidence[eid]["summary"] = summary
            return {"evidence_id": eid, "summary": summary, "rows": rows[-MAX_ROWS_TO_MODEL:]}
        if name == "get_downtime_events":
            days = max(1, min(int(args.get("days") or 60), 180))
            sql = f"""SELECT well_id, event_date, category, reason_original, hours_lost, planned, is_open, _bronze_id
                      FROM {S}.gold_downtime_events WHERE well_id = :w AND event_date > date_sub(DATE'2026-11-22', :d) ORDER BY event_date"""
            rows = self.q(sql, {"w": well, "d": days})
            eid = self._ev(conv, name, "gold", f"{S}.gold_downtime_events", sql, {"w": well, "d": days}, rows, f"{well} downtime events, last {days} days", ["_bronze_id"])
            cats, hrs = {}, {}
            for r in rows:
                cats[r["category"]] = cats.get(r["category"], 0) + 1
                hrs[r["category"]] = round(hrs.get(r["category"], 0) + (r["hours_lost"] or 0), 1)
            summary = {"events": len(rows), "unplanned_events": sum(1 for r in rows if not r["planned"]), "open_events": sum(1 for r in rows if r["is_open"]),
                       "total_hours_lost": round(sum(r["hours_lost"] or 0 for r in rows), 1), "distinct_days_with_events": len({str(r["event_date"])[:10] for r in rows}), "events_by_category": cats, "hours_lost_by_category": hrs}
            conv.evidence[eid]["summary"] = summary
            return {"evidence_id": eid, "summary": summary, "events": [{k: v for k, v in r.items() if k != "_bronze_id"} for r in rows[-MAX_ROWS_TO_MODEL:]]}
        if name == "get_economics":
            sql = f"SELECT well_id, month, days_reported, oil_bbl, gas_mcf, boe, netback_cad, loe_cad, operating_margin_cad, netback_per_boe, loe_per_boe FROM {S}.gold_monthly_economics WHERE well_id = :w ORDER BY month"
            rows = self.q(sql, {"w": well})
            eid = self._ev(conv, name, "gold", f"{S}.gold_monthly_economics", sql, {"w": well}, rows, f"{well} monthly economics", ["well_id", "month"])
            return {"evidence_id": eid, "months": rows, "note": "November is a partial month (data through Nov 22)."}
        if name == "get_work_orders":
            sql = f"SELECT wo_number, well_id, wo_type, description, start_date, end_date, status, _bronze_id FROM {S}.silver_workorders WHERE well_id = :w ORDER BY wo_number"
            rows = self.q(sql, {"w": well})
            eid = self._ev(conv, name, "silver", f"{S}.silver_workorders", sql, {"w": well}, rows, f"{well} work orders", ["wo_number"])
            return {"evidence_id": eid, "work_orders": rows}
        if name == "find_wells":
            allowed = {"value_at_risk_cad_day", "perf_ratio_7d", "water_cut_change_pts", "gor_change_pct", "casing_psi_change", "downtime_events_14d", "margin_per_boe", "oil_7d_bopd"}
            sort = args.get("sort_by") if args.get("sort_by") in allowed else "value_at_risk_cad_day"
            where, p = [], {}
            for k in ("engineer_id", "reservoir", "lift_type", "area"):
                if args.get(k): where.append(f"lower({k}) = lower(:{k})"); p[k] = args[k]
            lim = max(1, min(int(args.get("limit") or 10), 25))
            sql = f"""SELECT well_id, well_name, engineer_id, reservoir, lift_type, area, oil_7d_bopd, perf_ratio_7d, water_cut_change_pts, gor_change_pct,
                      casing_psi_change, downtime_events_14d, consecutive_down_days, margin_per_boe, value_at_risk_cad_day
                      FROM {S}.gold_well_snapshot {('WHERE ' + ' AND '.join(where)) if where else ''}
                      ORDER BY {sort} {'ASC' if args.get('ascending') else 'DESC'} NULLS LAST LIMIT {lim}"""
            rows = self.q(sql, p)
            eid = self._ev(conv, name, "gold", f"{S}.gold_well_snapshot", sql, p, rows, f"Wells sorted by {sort}", ["well_id"])
            return {"evidence_id": eid, "wells": rows}
        if name == "portfolio_summary":
            p, where = {}, ""
            eng = args.get("engineer_id") or ctx.get("engineer_id")
            if eng and str(eng).upper() != "ALL": where, p = "WHERE engineer_id = :e", {"e": eng}
            sql = f"""SELECT count(*) AS wells, round(sum(oil_7d_bopd), 0) AS oil_7d_bopd_total, round(sum(target_7d_bopd), 0) AS type_curve_7d_bopd_total,
                      count_if(consecutive_down_days >= 1) AS wells_down, count_if(days_since_last_data >= 1) AS wells_missing_data,
                      round(sum(value_at_risk_cad_day), 0) AS value_at_risk_cad_day_total, count_if(margin_per_boe < 0) AS wells_negative_margin
                      FROM {S}.gold_well_snapshot {where}"""
            rows = self.q(sql, p)
            eid = self._ev(conv, name, "gold", f"{S}.gold_well_snapshot", sql, p, rows, f"Portfolio summary {p.get('e') or 'all engineers'}", [])
            return {"evidence_id": eid, "summary": rows[0]}
        if name == "get_safety_status":
            sql = f"SELECT * FROM {S}.gold_v_well_safety WHERE well_id = :w"
            rows = self.q(sql, {"w": well})
            if not rows: return {"error": f"no well {well}"}
            eid = self._ev(conv, name, "gold", f"{S}.gold_v_well_safety", sql, {"w": well}, rows, f"{well} safety status", ["well_id"])
            return {"evidence_id": eid, "safety": rows[0]}
        if name == "get_tests_and_inspections":
            only = args.get("only") or ("all" if well else "overdue")
            filt = {"all": "", "overdue": "AND c.overdue", "due_30d": "AND NOT c.overdue AND c.days_until_due <= 30", "failed": "AND c.last_result IN ('Fail', 'Serious')"}.get(only, "")
            if well: scope, p = "c.well_id = :w", {"w": well}
            else: scope, p = "d.engineer_id = :e", {"e": ctx.get("engineer_id") or "ENG-1"}
            sql = f"""SELECT c.well_id, c.test_type, c.test_group, c.safety_critical, c.last_test_date, c.last_result, c.result_value, c.result_unit, c.next_due_date, c.days_until_due, c.days_overdue, c.overdue, c.source, c.record_id
                      FROM {S}.gold_v_compliance_items c JOIN {S}.gold_well_dim d USING (well_id) WHERE {scope} {filt} ORDER BY c.days_until_due LIMIT 200"""
            rows = self.q(sql, p)
            summary = {"items": len(rows), "overdue": sum(1 for r in rows if r["overdue"]), "safety_critical_overdue": sum(1 for r in rows if r["overdue"] and r["safety_critical"]),
                       "failed": sum(1 for r in rows if r["last_result"] in ("Fail", "Serious")), "wells": len({r["well_id"] for r in rows})}
            eid = self._ev(conv, name, "gold", f"{S}.gold_v_compliance_items", sql, p, rows, f"Tests and inspections ({only}) for {well or ctx.get('engineer_name', 'portfolio')}", ["record_id"])
            conv.evidence[eid]["summary"] = summary
            return {"evidence_id": eid, "summary": summary, "tests": rows[:MAX_ROWS_TO_MODEL]}
        if name == "get_safety_events":
            dd = max(1, min(int(args.get("days") or 90), 365))
            if well: scope, p = "e.well_id = :w", {"w": well, "d": dd}
            else: scope, p = "d.engineer_id = :e", {"e": ctx.get("engineer_id") or "ENG-1", "d": dd}
            sql = f"""SELECT e.event_id, e.well_id, e.event_date, e.days_ago, e.category, e.event_type_original, e.description, e.planned, e.volume_m3, e.substance,
                      e.reportable, e.reported_to_regulator, e.status, e.source FROM {S}.gold_v_safety_events e JOIN {S}.gold_well_dim d USING (well_id)
                      WHERE {scope} AND e.days_ago <= cast(:d AS INT) {'AND e.status <> ' + "'Closed'" if args.get('open_only') else ''} ORDER BY e.event_date DESC LIMIT 200"""
            rows = self.q(sql, p)
            cats = {}
            for r in rows: cats[r["category"]] = cats.get(r["category"], 0) + 1
            summary = {"events": len(rows), "unplanned": sum(1 for r in rows if not r["planned"]), "open": sum(1 for r in rows if r["status"] != "Closed"),
                       "reportable_not_reported": sum(1 for r in rows if r["reportable"] and not r["reported_to_regulator"]), "events_by_category": cats}
            eid = self._ev(conv, name, "gold", f"{S}.gold_v_safety_events", sql, p, rows, f"Safety events, last {dd} days, {well or ctx.get('engineer_name', 'portfolio')}", ["event_id"])
            conv.evidence[eid]["summary"] = summary
            return {"evidence_id": eid, "summary": summary, "events": rows[:MAX_ROWS_TO_MODEL]}
        if name == "get_definitions":
            terms = [str(t)[:40] for t in (args.get("terms") or [])][:8] or ["Type curve"]
            conds = " OR ".join(f"lower(term) LIKE :t{i} OR lower(definition) LIKE :t{i}" for i in range(len(terms)))
            p = {f"t{i}": f"%{t.lower()}%" for i, t in enumerate(terms)}
            sql = f"SELECT term, topic, definition, source FROM {S}.gold_glossary WHERE {conds} ORDER BY topic, term LIMIT 12"
            rows = self.q(sql, p)
            eid = self._ev(conv, name, "gold", f"{S}.gold_glossary", sql, p, rows, "Definitions: " + ", ".join(terms), ["term"])
            return {"evidence_id": eid, "definitions": rows} if rows else {"evidence_id": eid, "definitions": [], "note": "No glossary entry matches; say the glossary doesn't define it."}
        if name == "get_my_rules":
            rules = ctx.get("rules") or []
            rows = [{"rule": r.get("name"), "on": r.get("enabled"), "severity": r.get("severity"), "points": r.get("weight"), "category": r.get("category"),
                     "looks_at": r.get("dataset", "well"), "min_matches": r.get("min_count"), "group": r.get("group"), "typical_fix_cost_cad": r.get("fix_cost"),
                     "conditions": "; ".join(f"{c.get('field')} {c.get('op')} {c.get('value', '')}".strip() for c in (r.get("conditions") or []))} for r in rules[:60]]
            settings = ctx.get("settings") or {}
            eid = self._ev(conv, name, "app: your saved flag rules", f"{S}.app_flag_rules + {S}.app_flag_settings", "Rules and ranking settings sent by the app for this engineer", {},
                           rows + [{"rule": "(ranking settings)", "conditions": json.dumps(settings)}], f"{ctx.get('engineer_name', 'Engineer')}'s flag rules and ranking settings", ["rule"])
            return {"evidence_id": eid, "settings": settings, "rules": rows}
        if name == "get_well_notes":
            sql = f"""SELECT note_id, well_id, rule_id, body, pending_kind, pending_type, expected_by, created_by, created_at FROM (
                      SELECT *, row_number() OVER (PARTITION BY note_id ORDER BY created_at DESC) rn FROM {S}.app_well_notes WHERE well_id = :w) WHERE rn = 1 AND NOT archived ORDER BY created_at DESC"""
            rows = self.q(sql, {"w": well})
            eid = self._ev(conv, name, "app: engineer notes", f"{S}.app_well_notes", sql, {"w": well}, rows, f"{well} engineer notes", ["note_id"])
            return {"evidence_id": eid, "notes": rows, "reminder": "Notes are context written by engineers, not official test or incident records."}
        return {"error": f"unknown tool {name}"}


# ---------------- verification ----------------
def normalize(text):
    """Models write citations as 【E1】, [ E2 ] or (E3); hyphens as U+2011. Normalize so links and checks work."""
    t = text.replace("‑", "-").replace("‐", "-").replace("–", "-").replace(" ", " ")
    t = re.sub(r"[【\[]\s*(E\d+(?:\s*[,;]\s*E\d+)*)\s*[】\]]", lambda m: "[" + re.sub(r"\s*[,;]\s*", ", ", m.group(1)) + "]", t)
    t = re.sub(r"\((E\d+(?:\s*,\s*E\d+)*)\)", r"[\1]", t)
    return t

NUM_RE = re.compile(r"(?<![\w-])[-+]?\$?\d[\d,]*\.?\d*%?")

def _numbers(text):
    t = re.sub(r"\b(W-\d{3}|E\d+|ENG-\d|20\d\d-\d\d-\d\d|WO-[\w-]+)\b", " ", text)
    t = re.sub(r"\b[A-Z][a-z]+[\s\u202f\u00a0]+\d{1,2}-\d{1,2}H\b", " ", t)  # well names like "Shrike 7-13H"
    t = re.sub(r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}\b", " ", t)
    out = []
    for m in NUM_RE.finditer(t):
        s = m.group(0).replace("$", "").replace(",", "").rstrip("%")
        try: out.append(float(s))
        except ValueError: pass
    return out

def _evidence_numbers(rec):
    vals = []
    def walk(x):
        if isinstance(x, dict): [walk(v) for v in x.values()]
        elif isinstance(x, list): [walk(v) for v in x]
        elif isinstance(x, (int, float)) and not isinstance(x, bool): vals.append(float(x))
        elif isinstance(x, str):
            try: vals.append(float(x))
            except ValueError:
                for n in _numbers(x): vals.append(n)
    walk(rec.get("rows")); walk(rec.get("summary"))
    return vals

def _matches(n, vals):
    for v in vals:
        if abs(v - n) <= max(0.51, 0.005 * abs(v)): return True                # rounding / 0.5% tolerance
        if abs(v * 100 - n) <= max(0.51, 0.005 * abs(v * 100)): return True    # 0.62 shown as 62%
    return False

def verify(text, conv, question=""):
    sentences = []
    for line in [l for l in text.split("\n") if l.strip()]:
        for s in re.split(r"(?<=[.!?])\s+(?=[A-Z*\-])", line.strip()):
            if s.strip(): sentences.append(s.strip())
    report = []
    for s in sentences:
        ids = [i.strip() for g in ID_RE.findall(s) for i in g.split(",")]
        known = [i for i in ids if i in conv.evidence]
        unknown = [i for i in ids if i not in conv.evidence]
        body = ID_RE.sub("", s)
        nums = [n for n in _numbers(body) if not (n == int(n) and 1 <= n <= 10 and re.match(r"^\s*[-*]?\s*\d+[.)]", body))]
        vals = [v for i in known for v in _evidence_numbers(conv.evidence[i])]
        qnums = _numbers(question) + [float(x) for x in re.findall(r"(?:last|past|previous)\s+(\d{1,2})[\s-]+days?|(\d{1,2})-day", body, re.I) for x in x if x]
        unmatched = [n for n in nums if not _matches(n, vals) and n not in qnums] if known else []
        # a sentence must carry a citation when it states a number or talks about a specific well
        claims = bool(_numbers(body)) or bool(re.search(r"\bW-\d{3}\b", body))
        advice = re.match(r"^\W*(suggested next step|next step|what to do|what to watch|remember|recommendation|why look)", body, re.I)
        factual = claims and not advice and not re.search(r"data doesn.t show|would you like|let me know", body, re.I) and not body.strip().endswith("?")
        status = "unknown_citation" if unknown else ("no_source" if factual and not ids else ("number_mismatch" if unmatched else ("ok" if ids else "not_factual")))
        report.append({"sentence": s, "citations": ids, "unknown": unknown, "unmatched_numbers": unmatched, "status": status})
    # a list item without its own citation inherits the nearest citation in the same answer, but only if every
    # number in it is found in that evidence (otherwise it stays flagged)
    for i, r in enumerate(report):
        if r["status"] != "no_source": continue
        body = ID_RE.sub("", r["sentence"]); nums = _numbers(body)
        for j in sorted([k for k in range(len(report)) if report[k]["citations"] and not report[k]["unknown"] and abs(k - i) <= 15], key=lambda k: (abs(k - i), k < i)):
            vals = [v for e in report[j]["citations"] for v in _evidence_numbers(conv.evidence[e])]
            wells = re.findall(r"\bW-\d{3}\b", body)
            ev_text = json.dumps([conv.evidence[e].get("rows") for e in report[j]["citations"]], default=str)
            if (nums and all(_matches(n, vals) for n in nums)) or (not nums and wells and all(x in ev_text for x in wells)):
                r.update(status="ok", citations=report[j]["citations"], inherited=True); break
    summary = {"statements": sum(1 for r in report if r["status"] != "not_factual"),
               "ok": sum(1 for r in report if r["status"] == "ok"),
               "no_source": sum(1 for r in report if r["status"] == "no_source"),
               "number_mismatch": sum(1 for r in report if r["status"] == "number_mismatch"),
               "unknown_citation": sum(1 for r in report if r["status"] == "unknown_citation")}
    return report, summary


# ---------------- agent loop ----------------
def run_agent(conv, user_text, ctx, llm, tools, max_steps=8):
    conv.touched = time.time()
    msgs = [{"role": "system", "content": SYSTEM + f"\nCurrent engineer: {ctx.get('engineer_name', 'not set')} ({ctx.get('engineer_id', '')})."}]
    msgs += conv.messages[-12:] + [{"role": "user", "content": user_text}]
    specs = [{"type": "function", "function": t} for t in tool_specs()]
    trace, nudged = [], False
    for _ in range(max_steps):
        out = llm(msgs, specs)
        m = out["choices"][0]["message"]
        calls = m.get("tool_calls") or []
        if not calls:
            text = m.get("content")
            if isinstance(text, list): text = "".join(p.get("text", "") for p in text if isinstance(p, dict) and p.get("type") == "text")
            text = normalize((text or "").strip())
            looked_up = [t["evidence_id"] for t in trace if t.get("evidence_id")]
            if not looked_up and not nudged:  # answered from memory: make it look the answer up before replying
                nudged = True
                msgs.append({"role": "assistant", "content": text})
                msgs.append({"role": "user", "content": "Before answering, call the tool(s) that back your answer (get_definitions for terms, get_my_rules for how flags and ranking work, data tools for anything about wells). Then answer again, citing the evidence ids."})
                continue
            conv.messages += [{"role": "user", "content": user_text}, {"role": "assistant", "content": text}]
            report, summary = verify(text, conv, user_text)
            cited = {c for r in report for c in r["citations"]}
            sources = [{"id": e, "cited": e in cited} for e in dict.fromkeys(looked_up)]
            sources += [{"id": e, "cited": True} for e in sorted(cited - set(looked_up), key=lambda x: int(x[1:])) if e in conv.evidence]  # cited from earlier turns
            summary["sources"] = len(sources); summary["unsourced"] = not sources
            return {"answer": text, "trace": trace, "verification": report, "summary": summary, "sources": sources}
        msgs.append({"role": "assistant", "content": m.get("content") or "", "tool_calls": calls})
        for c in calls:
            name = c["function"]["name"]
            try: args = json.loads(c["function"].get("arguments") or "{}")
            except json.JSONDecodeError: args = {}
            try: result = tools.run(conv, name, args, ctx)
            except Exception as e: result = {"error": str(e)[:300]}
            trace.append({"tool": name, "args": args, "evidence_id": result.get("evidence_id"), "error": result.get("error")})
            msgs.append({"role": "tool", "tool_call_id": c["id"], "content": json.dumps(result, default=str)[:12000]})
    text = "I couldn't finish looking that up. Try a narrower question."
    looked_up = list(dict.fromkeys(t["evidence_id"] for t in trace if t.get("evidence_id")))
    return {"answer": text, "trace": trace, "verification": [], "sources": [{"id": e, "cited": False} for e in looked_up],
            "summary": {"statements": 0, "ok": 0, "no_source": 0, "number_mismatch": 0, "unknown_citation": 0, "sources": len(looked_up), "unsourced": not looked_up}}
