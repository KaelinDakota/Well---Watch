"""Well Watch - Databricks App.

Sits on top of the workspace.well_ops medallion (bronze -> silver -> gold). Serves:
  * the snapshot of every well plus each engineer's saved flag rules (ranking runs in the browser, deterministic)
  * well detail (daily history, downtime, economics, work orders)
  * our own chat agent (agent.py) on a Databricks-hosted foundation model, whose every fact is an evidence record
  * lineage: any gold row traced back to the silver row, the bronze rows and the raw file it came from
Never reads the answer-key schema (workspace.well_eval)."""
import json, os, re, threading, time, uuid
from functools import lru_cache

import requests
from databricks.sdk import WorkspaceClient
from databricks.sdk.service.sql import StatementParameterListItem, StatementState
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse

import agent

S = os.getenv("WELL_SCHEMA", "workspace.well_ops")
WAREHOUSE_ID = os.getenv("DATABRICKS_WAREHOUSE_ID")
LLM_ENDPOINT = os.getenv("LLM_ENDPOINT", "databricks-gpt-oss-120b")
HERE = os.path.dirname(os.path.abspath(__file__))
WELL_RE = re.compile(r"W-\d{3}")
ENG_RE = re.compile(r"ENG-\d")
app = FastAPI(title="Well Watch")


@lru_cache(maxsize=1)
def ws() -> WorkspaceClient:
    return WorkspaceClient()


def query(statement, params=None):
    p = [StatementParameterListItem(name=k, value=None if v is None else str(v)) for k, v in (params or {}).items()]
    r = ws().statement_execution.execute_statement(statement=statement, warehouse_id=WAREHOUSE_ID, parameters=p, wait_timeout="50s")
    while r.status.state in (StatementState.PENDING, StatementState.RUNNING):
        time.sleep(1); r = ws().statement_execution.get_statement(r.statement_id)
    if r.status.state != StatementState.SUCCEEDED:
        raise HTTPException(500, f"Query failed: {r.status.error.message if r.status.error else r.status.state}")
    if not r.result or not r.manifest.schema: return []
    cols = [(c.name, c.type_name.value) for c in r.manifest.schema.columns]
    rows = list(r.result.data_array or [])
    nxt = r.result.next_chunk_index
    while nxt is not None:
        ch = ws().statement_execution.get_statement_result_chunk_n(r.statement_id, nxt); rows += ch.data_array or []; nxt = ch.next_chunk_index
    def conv(v, t):
        if v is None: return None
        if t in ("DOUBLE", "DECIMAL", "FLOAT"): return float(v)
        if t in ("INT", "LONG", "SHORT", "BYTE"): return int(v)
        if t == "BOOLEAN": return v == "true"
        if t == "ARRAY":
            try: return json.loads(v)
            except ValueError: return v
        return v
    return [{c: conv(v, t) for (c, t), v in zip(cols, row)} for row in rows]


for name in ("index.html", "app.js", "flags.js"):
    app.add_api_route(f"/{'' if name == 'index.html' else name}", (lambda n: lambda: FileResponse(os.path.join(HERE, "static", n)))(name), methods=["GET"])


# ---------------- data ----------------
_cache = {}
def cached(key, fn, ttl=300):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl: return hit[1]
    v = fn(); _cache[key] = (time.time(), v); return v


@app.get("/api/bundle")
def bundle():
    prod = cached("snap", lambda: query(f"SELECT * FROM {S}.gold_well_snapshot ORDER BY well_id"))
    safety = {r["well_id"]: r for r in query(f"SELECT * FROM {S}.gold_v_well_safety")}  # live: includes tests/events engineers just logged
    snap = [dict(r, **{k: v for k, v in safety.get(r["well_id"], {}).items() if k != "well_id"}) for r in prod]
    engineers = cached("eng", lambda: query(f"SELECT DISTINCT engineer_id, engineer_name FROM {S}.gold_well_dim ORDER BY engineer_id"))
    saved = query(f"""SELECT engineer_id, rules_json, mode, saved_by, saved_at FROM (
                        SELECT *, row_number() OVER (PARTITION BY engineer_id ORDER BY saved_at DESC) rn FROM {S}.app_flag_rules) WHERE rn = 1""")
    rules = {r["engineer_id"]: {"rules": json.loads(r["rules_json"]), "mode": r["mode"], "saved_by": r["saved_by"], "saved_at": r["saved_at"]} for r in saved}
    settings = {r["engineer_id"]: r["safety_first"] for r in query(f"""SELECT engineer_id, safety_first FROM (SELECT *, row_number() OVER (PARTITION BY engineer_id ORDER BY saved_at DESC) rn
                                                                    FROM {S}.app_flag_settings) WHERE rn = 1""")}
    return {"as_of": "2026-11-22", "today": "2026-11-23", "snapshot": snap, "engineers": engineers, "saved_rules": rules, "safety_first": settings,
            "items": {"test": query(f"SELECT * FROM {S}.gold_v_compliance_items"), "event": query(f"SELECT * FROM {S}.gold_v_safety_events")},
            "custom_fields": query(f"""SELECT field_key, label, field_type, help FROM (SELECT *, row_number() OVER (PARTITION BY field_key ORDER BY created_at DESC) rn
                                       FROM {S}.app_custom_fields) WHERE rn = 1 AND field_type <> 'deleted' ORDER BY label"""),
            "attributes": query(f"""SELECT well_id, field_key, value, updated_by, updated_at FROM (SELECT *, row_number() OVER (PARTITION BY well_id, field_key ORDER BY updated_at DESC) rn
                                    FROM {S}.app_well_attributes) WHERE rn = 1"""),
            "test_catalog": cached("cat", lambda: query(f"SELECT * FROM {S}.silver_test_catalog ORDER BY test_group, test_type")),
            "cleaning_rules": cached("clean", lambda: query(f"SELECT rule_id, description FROM {S}.silver_cleaning_rules ORDER BY rule_id")),
            "model": LLM_ENDPOINT}


@app.get("/api/well/{well_id}")
def well(well_id: str):
    if not WELL_RE.fullmatch(well_id): raise HTTPException(400, "bad well id")
    p = {"w": well_id}
    return {
        "daily": query(f"""SELECT prod_date, reported, hours_on, oil_bbl, target_oil_bopd, water_bbl, gas_mcf, water_cut, gor_scf_bbl, tubing_psi, casing_psi, dq_sensor_error
                           FROM {S}.gold_daily_well WHERE well_id = :w AND prod_date >= date'2026-08-01' ORDER BY prod_date""", p),
        "downtime": query(f"""SELECT event_date, event_start, category, reason_original, hours_lost, planned, is_open, _bronze_id
                              FROM {S}.gold_downtime_events WHERE well_id = :w ORDER BY event_start DESC LIMIT 60""", p),
        "economics": query(f"SELECT * FROM {S}.gold_monthly_economics WHERE well_id = :w ORDER BY month", p),
        "work_orders": query(f"SELECT wo_number, wo_type, description, start_date, end_date, status, _bronze_id FROM {S}.silver_workorders WHERE well_id = :w ORDER BY start_date DESC", p),
        "dim": (query(f"SELECT * FROM {S}.silver_wells WHERE well_id = :w", p) or [None])[0],
        "safety_daily": query(f"""SELECT reading_date, sc_psi, surface_casing_limit_psi, flowline_psi_max, flowline_maop_psi, casing_psi, prod_casing_maasp_psi, h2s_ambient_ppm_max, vent_gas_m3
                                  FROM {S}.gold_safety_daily WHERE well_id = :w AND reading_date >= date'2026-08-01' ORDER BY reading_date""", p),
        "register": (query(f"SELECT * FROM {S}.silver_well_safety WHERE well_id = :w", p) or [None])[0],
        "test_history": query(f"""SELECT test_id AS record_id, test_type, test_group, test_date, result_status, result_original, result_value, result_unit, notes, 'system' AS source
                                  FROM {S}.silver_compliance_tests WHERE well_id = :w
                                  UNION ALL SELECT entry_id, test_type, test_group, test_date, result_status, result_status, result_value, result_unit, notes, 'app: ' || entered_by
                                  FROM {S}.app_compliance_entries WHERE well_id = :w ORDER BY test_date DESC""", p),
    }


@app.put("/api/rules/{engineer_id}")
async def save_rules(engineer_id: str, request: Request):
    if not ENG_RE.fullmatch(engineer_id): raise HTTPException(400, "bad engineer id")
    body = await request.json()
    rules, mode = body.get("rules"), body.get("mode", "score")
    if not isinstance(rules, list) or len(rules) > 100 or mode not in ("score", "value"):
        raise HTTPException(400, "rules must be a list; mode is score or value")
    who = request.headers.get("x-forwarded-email") or request.headers.get("x-forwarded-preferred-username") or "unknown"
    query(f"INSERT INTO {S}.app_flag_rules VALUES (:e, :r, :m, :who, current_timestamp())", {"e": engineer_id, "r": json.dumps(rules), "m": mode, "who": who})
    if "safety_first" in body:
        query(f"INSERT INTO {S}.app_flag_settings VALUES (:e, cast(:sf AS BOOLEAN), :who, current_timestamp())", {"e": engineer_id, "sf": str(bool(body["safety_first"])).lower(), "who": who})
    return {"ok": True, "saved_by": who}


# ---------------- safety entries made by engineers ----------------
def _who(request): return request.headers.get("x-forwarded-email") or request.headers.get("x-forwarded-preferred-username") or "unknown"
def _txt(v, n=500): return None if v in (None, "") else str(v)[:n]
def _num(v):
    if v in (None, ""): return None
    try: return float(v)
    except (TypeError, ValueError): raise HTTPException(400, f"not a number: {v}")
def _date(v):
    if not (isinstance(v, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", v)): raise HTTPException(400, "dates must be YYYY-MM-DD")
    return v
def _well(v):
    if not (isinstance(v, str) and WELL_RE.fullmatch(v)): raise HTTPException(400, "bad well id")
    return v
b2s = lambda v: "true" if v in (True, "true", "Y", "yes", 1) else "false"


@app.post("/api/tests")
async def log_test(request: Request):
    """Log a test or inspection of any type. Unknown types are fine: interval and safety-critical come from the form."""
    b = await request.json()
    if not _txt(b.get("test_type")): raise HTTPException(400, "test type is required")
    if b.get("result_status") not in ("Pass", "Fail", "Non-serious", "Serious"): raise HTTPException(400, "result must be Pass, Fail, Non-serious or Serious")
    iv = _num(b.get("interval_months"))
    if not iv or iv <= 0: raise HTTPException(400, "interval (months) must be more than 0")
    eid = "APP-T-" + uuid.uuid4().hex[:10]
    query(f"""INSERT INTO {S}.app_compliance_entries VALUES (:id, :w, :t, :g, cast(:iv AS INT), cast(:sc AS BOOLEAN), cast(:d AS DATE), :r, cast(:v AS DOUBLE), :u, :n, :who, current_timestamp())""",
          {"id": eid, "w": _well(b.get("well_id")), "t": _txt(b["test_type"], 120), "g": _txt(b.get("test_group"), 60) or "Custom", "iv": int(iv), "sc": b2s(b.get("safety_critical")),
           "d": _date(b.get("test_date")), "r": b["result_status"], "v": _num(b.get("result_value")), "u": _txt(b.get("result_unit"), 30), "n": _txt(b.get("notes")), "who": _who(request)})
    return {"ok": True, "entry_id": eid}


@app.post("/api/events")
async def log_event(request: Request):
    """Log a safety event of any category."""
    b = await request.json()
    if not _txt(b.get("category")): raise HTTPException(400, "category is required")
    if b.get("status") not in ("Open", "Closed"): raise HTTPException(400, "status must be Open or Closed")
    eid = "APP-E-" + uuid.uuid4().hex[:10]
    query(f"""INSERT INTO {S}.app_safety_event_entries VALUES (:id, :w, cast(:d AS DATE), :c, :desc, cast(:pl AS BOOLEAN), cast(:v AS DOUBLE), :sub,
              cast(:rep AS BOOLEAN), cast(:rtd AS BOOLEAN), :st, :who, current_timestamp())""",
          {"id": eid, "w": _well(b.get("well_id")), "d": _date(b.get("event_date")), "c": _txt(b["category"], 80), "desc": _txt(b.get("description")), "pl": b2s(b.get("planned")),
           "v": _num(b.get("volume_m3")), "sub": _txt(b.get("substance"), 80), "rep": b2s(b.get("reportable")), "rtd": b2s(b.get("reported_to_regulator")), "st": b["status"], "who": _who(request)})
    return {"ok": True, "event_id": eid}


@app.post("/api/events/{event_id}/update")
async def update_event(event_id: str, request: Request):
    """Close an event, or record that it was reported to the regulator. Works for field-log and app events."""
    if not re.fullmatch(r"(SE\d{5}|APP-E-[0-9a-f]{10})", event_id): raise HTTPException(400, "bad event id")
    b = await request.json()
    if b.get("status") not in ("Open", "Closed"): raise HTTPException(400, "status must be Open or Closed")
    query(f"INSERT INTO {S}.app_event_updates VALUES (:id, :st, cast(:r AS BOOLEAN), :n, :who, current_timestamp())",
          {"id": event_id, "st": b["status"], "r": None if b.get("reported_to_regulator") is None else b2s(b.get("reported_to_regulator")), "n": _txt(b.get("note")), "who": _who(request)})
    return {"ok": True}


@app.post("/api/custom_fields")
async def define_field(request: Request):
    """Define a per-well field (number, text, yes/no, date) any rule can use. field_type 'deleted' removes it."""
    b = await request.json()
    label = _txt(b.get("label"), 80)
    if not label: raise HTTPException(400, "label is required")
    if b.get("field_type") not in ("number", "text", "yesno", "date", "deleted"): raise HTTPException(400, "type must be number, text, yesno or date")
    key = b.get("field_key") or re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")[:40]
    if not re.fullmatch(r"[a-z0-9_]{1,40}", key): raise HTTPException(400, "bad field key")
    query(f"INSERT INTO {S}.app_custom_fields VALUES (:k, :l, :t, :h, :who, current_timestamp())", {"k": key, "l": label, "t": b["field_type"], "h": _txt(b.get("help"), 200), "who": _who(request)})
    return {"ok": True, "field_key": key}


@app.put("/api/attributes/{well_id}")
async def set_attributes(well_id: str, request: Request):
    """Set values of custom fields for one well: {"values": {"field_key": "value", ...}}. Empty string clears a value."""
    _well(well_id); b = await request.json(); vals = b.get("values") or {}
    if not isinstance(vals, dict) or len(vals) > 50: raise HTTPException(400, "values must be an object")
    for k, v in vals.items():
        if not re.fullmatch(r"[a-z0-9_]{1,40}", k): raise HTTPException(400, "bad field key")
        query(f"INSERT INTO {S}.app_well_attributes VALUES (:w, :k, :v, :who, current_timestamp())", {"w": well_id, "k": k, "v": _txt(v, 200), "who": _who(request)})
    return {"ok": True}


# ---------------- lineage ----------------
@app.get("/api/lineage")
def lineage(kind: str, well_id: str = "", date: str = "", bronze_id: str = "", month: str = ""):
    """Walk a gold record back to silver, bronze and the raw landing file."""
    if well_id and not WELL_RE.fullmatch(well_id): raise HTTPException(400, "bad well id")
    if date and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date): raise HTTPException(400, "bad date")
    if bronze_id and kind not in ("test", "safety_event") and not re.fullmatch(r"[0-9a-f]{6,64}", bronze_id): raise HTTPException(400, "bad id")
    clean = {r["rule_id"]: r["description"] for r in cached("clean", lambda: query(f"SELECT rule_id, description FROM {S}.silver_cleaning_rules"))}
    steps = []
    if kind == "daily":
        gold = query(f"SELECT * FROM {S}.gold_daily_well WHERE well_id = :w AND prod_date = :d", {"w": well_id, "d": date})
        steps.append({"layer": "gold", "table": f"{S}.gold_daily_well", "note": "Date spine joined to the type curve; water cut and GOR computed here.", "rows": gold})
        silver = query(f"SELECT * FROM {S}.silver_daily_production WHERE well_id = :w AND prod_date = :d", {"w": well_id, "d": date})
        steps.append({"layer": "silver", "table": f"{S}.silver_daily_production", "note": "One cleaned row per well-day.", "rows": silver,
                      "rules": [{"rule_id": r, "description": clean.get(r, "")} for row in silver for r in (row.get("rules_applied") or [])]})
        if silver:
            b = query(f"""SELECT b.* FROM {S}.bronze_scada_daily b WHERE (b.UWI_ALIAS, b.PROD_DATE) IN
                            (SELECT UWI_ALIAS, PROD_DATE FROM {S}.bronze_scada_daily WHERE _bronze_id = :b) ORDER BY _loaded_at DESC""", {"b": silver[0]["_bronze_id"]})
            for r in b: r["_used_in_silver"] = r["_bronze_id"] == silver[0]["_bronze_id"]
            steps.append({"layer": "bronze", "table": f"{S}.bronze_scada_daily", "note": f"{len(b)} raw row(s) for this well-day; the one marked 'used' won.", "rows": b})
            steps.append({"layer": "raw", "table": "landing volume", "note": "Raw CSV file(s) as received from SCADA.", "files": sorted({r["_source_file"] for r in b})})
        elif gold and not gold[0].get("reported"):
            steps.append({"layer": "silver", "table": "-", "note": "No SCADA row arrived for this day, so gold shows it as not reported.", "rows": []})
    elif kind == "downtime":
        g = query(f"SELECT * FROM {S}.gold_downtime_events WHERE _bronze_id = :b", {"b": bronze_id})
        steps.append({"layer": "gold", "table": f"{S}.gold_downtime_events", "note": "Silver event plus well name and engineer.", "rows": g})
        s = query(f"SELECT * FROM {S}.silver_downtime_events WHERE _bronze_id = :b", {"b": bronze_id})
        steps.append({"layer": "silver", "table": f"{S}.silver_downtime_events", "note": "Reason text categorized by ai_classify; original text kept.", "rows": s,
                      "rules": [{"rule_id": r, "description": clean.get(r, "")} for row in s for r in (row.get("rules_applied") or [])]})
        b = query(f"SELECT * FROM {S}.bronze_downtime_log WHERE _bronze_id = :b", {"b": bronze_id})
        steps.append({"layer": "bronze", "table": f"{S}.bronze_downtime_log", "note": "Operator's downtime log row, as typed.", "rows": b})
        steps.append({"layer": "raw", "table": "landing volume", "files": sorted({r["_source_file"] for r in b})})
    elif kind == "economics":
        if not re.fullmatch(r"\d{4}-\d{2}(-\d{2})?", month): raise HTTPException(400, "bad month")
        m = month[:7] + "-01"
        steps.append({"layer": "gold", "table": f"{S}.gold_monthly_economics", "note": "Volumes from gold_daily_well x gold_price_assumptions, minus LOE.",
                      "rows": query(f"SELECT * FROM {S}.gold_monthly_economics WHERE well_id = :w AND month = :m", {"w": well_id, "m": m})})
        steps.append({"layer": "gold", "table": f"{S}.gold_price_assumptions", "rows": query(f"SELECT * FROM {S}.gold_price_assumptions")})
        s = query(f"SELECT * FROM {S}.silver_loe WHERE well_id = :w AND month = :m", {"w": well_id, "m": m})
        steps.append({"layer": "silver", "table": f"{S}.silver_loe", "rows": s})
        if s:
            b = query(f"SELECT * FROM {S}.bronze_loe WHERE _bronze_id = :b", {"b": s[0]["_bronze_id"]})
            steps.append({"layer": "bronze", "table": f"{S}.bronze_loe", "rows": b})
            steps.append({"layer": "raw", "table": "landing volume", "files": sorted({r["_source_file"] for r in b})})
    elif kind == "work_order":
        s = query(f"SELECT * FROM {S}.silver_workorders WHERE _bronze_id = :b", {"b": bronze_id})
        steps.append({"layer": "silver", "table": f"{S}.silver_workorders", "rows": s})
        b = query(f"SELECT * FROM {S}.bronze_workorders WHERE _bronze_id = :b", {"b": bronze_id})
        steps.append({"layer": "bronze", "table": f"{S}.bronze_workorders", "rows": b})
        steps.append({"layer": "raw", "table": "landing volume", "files": sorted({r["_source_file"] for r in b})})
    elif kind == "snapshot":
        steps.append({"layer": "gold", "table": f"{S}.gold_well_snapshot", "note": "One row per well as of 2026-11-22. Recent window Nov 16-22; baseline Oct 10 - Nov 8.",
                      "rows": query(f"SELECT * FROM {S}.gold_well_snapshot WHERE well_id = :w", {"w": well_id})})
        steps.append({"layer": "gold", "table": f"{S}.gold_daily_well", "note": "Daily rows the snapshot averages (last 14 days shown).",
                      "rows": query(f"SELECT * FROM {S}.gold_daily_well WHERE well_id = :w AND prod_date >= date'2026-11-09' ORDER BY prod_date", {"w": well_id}),
                      "trace_daily": True})
    elif kind == "safety_daily":
        g = query(f"SELECT * FROM {S}.gold_safety_daily WHERE well_id = :w AND reading_date = :d", {"w": well_id, "d": date})
        steps.append({"layer": "gold", "table": f"{S}.gold_safety_daily", "note": "Readings joined to this well's limits (MAASP, surface casing limit, MAOP).", "rows": g})
        s_ = query(f"SELECT * FROM {S}.silver_safety_readings WHERE well_id = :w AND reading_date = :d", {"w": well_id, "d": date})
        steps.append({"layer": "silver", "table": f"{S}.silver_safety_readings", "rows": s_, "rules": [{"rule_id": r, "description": clean.get(r, "")} for row in s_ for r in (row.get("rules_applied") or [])]})
        reg = query(f"SELECT * FROM {S}.silver_well_safety WHERE well_id = :w", {"w": well_id})
        steps.append({"layer": "silver", "table": f"{S}.silver_well_safety", "note": "Where the limits come from.", "rows": reg,
                      "rules": [{"rule_id": r, "description": clean.get(r, "")} for row in reg for r in (row.get("rules_applied") or [])]})
        if s_:
            b = query(f"SELECT * FROM {S}.bronze_safety_readings WHERE _bronze_id = :b", {"b": s_[0]["_bronze_id"]})
            steps.append({"layer": "bronze", "table": f"{S}.bronze_safety_readings", "rows": b})
            rb = query(f"SELECT * FROM {S}.bronze_well_safety_register WHERE well_id = :w", {"w": well_id})
            steps.append({"layer": "bronze", "table": f"{S}.bronze_well_safety_register", "note": "Limits as exported (pressure_unit shows kPa or psi).", "rows": rb})
            steps.append({"layer": "raw", "table": "landing volume", "files": sorted({r["_source_file"] for r in b + rb})})
    elif kind == "test":
        if not re.fullmatch(r"(T\d{5}|APP-T-[0-9a-f]{10})", bronze_id): raise HTTPException(400, "bad test id")
        if bronze_id.startswith("APP-"):
            steps.append({"layer": "silver", "table": f"{S}.app_compliance_entries", "note": "Logged by an engineer in Well Watch.",
                          "rows": query(f"SELECT * FROM {S}.app_compliance_entries WHERE entry_id = :b", {"b": bronze_id})})
        else:
            s_ = query(f"SELECT * FROM {S}.silver_compliance_tests WHERE test_id = :b", {"b": bronze_id})
            steps.append({"layer": "silver", "table": f"{S}.silver_compliance_tests", "note": "Result normalized; catalog interval and safety-critical flag joined.", "rows": s_,
                          "rules": [{"rule_id": r, "description": clean.get(r, "")} for row in s_ for r in (row.get("rules_applied") or [])]})
            b = query(f"SELECT * FROM {S}.bronze_compliance_tests WHERE test_id = :b", {"b": bronze_id})
            steps.append({"layer": "bronze", "table": f"{S}.bronze_compliance_tests", "note": "As exported from the compliance system.", "rows": b})
            steps.append({"layer": "raw", "table": "landing volume", "files": sorted({r["_source_file"] for r in b})})
    elif kind == "safety_event":
        if not re.fullmatch(r"(SE\d{5}|APP-E-[0-9a-f]{10})", bronze_id): raise HTTPException(400, "bad event id")
        steps.append({"layer": "gold", "table": f"{S}.gold_v_safety_events", "note": "Event with the latest status update applied.",
                      "rows": query(f"SELECT * FROM {S}.gold_v_safety_events WHERE event_id = :b", {"b": bronze_id})})
        upd = query(f"SELECT * FROM {S}.app_event_updates WHERE event_id = :b ORDER BY updated_at DESC", {"b": bronze_id})
        if upd: steps.append({"layer": "silver", "table": f"{S}.app_event_updates", "note": "Status updates made in Well Watch.", "rows": upd})
        if bronze_id.startswith("APP-"):
            steps.append({"layer": "silver", "table": f"{S}.app_safety_event_entries", "note": "Logged by an engineer in Well Watch.",
                          "rows": query(f"SELECT * FROM {S}.app_safety_event_entries WHERE event_id = :b", {"b": bronze_id})})
        else:
            s_ = query(f"SELECT * FROM {S}.silver_safety_events WHERE event_id = :b", {"b": bronze_id})
            steps.append({"layer": "silver", "table": f"{S}.silver_safety_events", "note": "Category assigned by ai_classify; original type kept.", "rows": s_,
                          "rules": [{"rule_id": r, "description": clean.get(r, "")} for row in s_ for r in (row.get("rules_applied") or [])]})
            b = query(f"SELECT * FROM {S}.bronze_safety_events WHERE event_id = :b", {"b": bronze_id})
            steps.append({"layer": "bronze", "table": f"{S}.bronze_safety_events", "rows": b})
            steps.append({"layer": "raw", "table": "landing volume", "files": sorted({r["_source_file"] for r in b})})
    elif kind == "safety_snapshot":
        steps.append({"layer": "gold", "table": f"{S}.gold_v_well_safety", "note": "Safety fields the rules use. Recent = Nov 16-22, baseline = Oct 10 - Nov 8, month to date = Nov 1-22.",
                      "rows": query(f"SELECT * FROM {S}.gold_v_well_safety WHERE well_id = :w", {"w": well_id})})
        steps.append({"layer": "gold", "table": f"{S}.gold_safety_daily", "note": "Daily readings behind it (last 14 days).", "trace_safety": True,
                      "rows": query(f"SELECT * FROM {S}.gold_safety_daily WHERE well_id = :w AND reading_date >= date'2026-11-09' ORDER BY reading_date", {"w": well_id})})
    else:
        raise HTTPException(400, "unknown lineage kind")
    return {"kind": kind, "steps": steps}


# ---------------- chat ----------------
CONVS, LOCK = {}, threading.Lock()

def llm(msgs, tools):
    hdr = ws().config.authenticate(); hdr["Content-Type"] = "application/json"
    for attempt in range(3):
        r = requests.post(f"{ws().config.host}/serving-endpoints/{LLM_ENDPOINT}/invocations", headers=hdr, timeout=120,
                          json={"messages": msgs, "tools": tools, "max_tokens": 1200, "temperature": 0.1})
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(2 * (attempt + 1)); continue
        if r.status_code >= 400: raise HTTPException(502, f"Model endpoint error {r.status_code}: {r.text[:300]}")
        return r.json()
    raise HTTPException(503, "The model endpoint is busy. Try again in a moment.")


@app.post("/api/chat")
def chat(body: dict):  # sync: FastAPI runs it in a worker thread, so a long model call doesn't block other requests
    text = (body.get("message") or "").strip()[:2000]
    if not text: raise HTTPException(400, "empty message")
    eng = body.get("engineer_id") or ""
    if eng and not ENG_RE.fullmatch(eng): raise HTTPException(400, "bad engineer id")
    snap_ids = {r["well_id"] for r in cached("snap", lambda: query(f"SELECT * FROM {S}.gold_well_snapshot ORDER BY well_id"))}
    ranking = [r for r in (body.get("ranking") or [])[:200] if isinstance(r, dict) and r.get("well_id") in snap_ids]
    with LOCK:
        for k in [k for k, c in CONVS.items() if time.time() - c.touched > 3600]: CONVS.pop(k, None)
        conv = CONVS.get(body.get("conversation_id") or "")
        if conv is None:
            conv = agent.Conversation(); CONVS[conv.id] = conv
    ctx = {"engineer_id": eng, "engineer_name": body.get("engineer_name") or eng, "ranking": ranking}
    res = agent.run_agent(conv, text, ctx, llm, agent.Tools(query, S))
    ev = {}
    for t in res["trace"]:
        e = conv.evidence.get(t.get("evidence_id") or "")
        if e: ev[e["id"]] = e
    for r in res["verification"]:
        for i in r["citations"]:
            if i in conv.evidence: ev[i] = conv.evidence[i]
    return {"conversation_id": conv.id, **res, "evidence": ev, "model": LLM_ENDPOINT}
