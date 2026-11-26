"""Production issues (detection to close), downtime reason codes, repeat failures and the morning briefing / call.

Rules this module keeps (from the app's operating principles):
- Safety comes first. Safety flags never become production issues; they go to Safety incidents. In the briefing the
  safety lines are written by the app from the records, not by the AI, so nothing can soften, reorder or drop them.
- People move an issue from state to state. The AI only pre-fills the close-out (reason code, lost volume, cost,
  outcome); a person confirms, edits or rejects it, and that decision is logged.
- Show your work: every briefing line cites the facts it came from (source table and as-of date). AI lines whose
  numbers are not in the facts they cite are dropped; if none survive, the briefing falls back to the facts themselves.
- No fabrication: verification says plainly when there is not enough production data after a fix to judge it.
- Everything is append-only and every action goes to app_issue_events.
"""
import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException, Request

import alerts

STATES = ["Detected", "Triaged", "Diagnosing", "Fix Planned", "Awaiting Approval", "Scheduled", "In Progress", "Verifying", "Closed"]
DISMISSED = "Dismissed"
OPEN_STATES = STATES[:-1]
# Where each state can go next (besides Dismissed, which any open issue can go to with a reason).
NEXT = {
    "Detected": ["Triaged"],
    "Triaged": ["Diagnosing", "Fix Planned"],
    "Diagnosing": ["Fix Planned"],
    "Fix Planned": ["Awaiting Approval", "Scheduled"],
    "Awaiting Approval": ["Scheduled", "Fix Planned"],
    "Scheduled": ["In Progress"],
    "In Progress": ["Verifying"],
    "Verifying": ["Closed", "Diagnosing"],
    "Closed": ["Diagnosing"],      # reopen
    DISMISSED: ["Triaged"],        # reopen
}
FIX_TYPES = ["Optimize (settings or chemical)", "Repair on surface", "Service rig / workover", "Facility or midstream", "Wait (weather or third party)", "Other"]
OUTCOMES = ["Fixed", "Partly fixed", "Not fixed"]
SYSTEM_ACTOR = "Well Watch (automatic)"
SOURCES = {"snap": "gold_well_snapshot", "daily": "gold_daily_well", "down": "gold_v_downtime_coded", "repeat": "gold_v_repeat_failures",
           "issue": "app_production_issues", "incident": "app_safety_incidents", "flag": "flag rules (this page)"}


def _now():
    return datetime.now(timezone.utc)


def _ts(d):
    return d.strftime("%Y-%m-%d %H:%M:%S.%f")


def _txt(v, n=2000):
    v = v.strip() if isinstance(v, str) else v
    return None if v in (None, "") else str(v)[:n]


def _num(v, what):
    if v in (None, ""): return None
    try: return float(str(v).replace(",", "").replace("$", ""))
    except ValueError: raise HTTPException(400, f"{what} must be a number.")


def _date(v, what):
    if v in (None, ""): return None
    try: return date.fromisoformat(str(v)[:10])
    except ValueError: raise HTTPException(400, f"{what} must be a date (YYYY-MM-DD).")


def _f(v, d=0):
    return "—" if v is None else f"{v:,.{d}f}"


CLOSE_PROMPT = """You help a production engineer close out a well production issue. Use ONLY the issue record and thread given.
Pick the one standard downtime reason code that best fits what the record says caused the problem, from this list:
{codes}
Return one JSON object: {{"reason_code": "<code from the list, or null>", "quote": "<exact words from the record that support the code>",
"outcome_note": "<one or two plain sentences: what was wrong, what was done, and the result, using only facts in the record>"}}
If the record does not say what caused it, set reason_code to null. Never guess a cause and never add numbers that are not in the record."""

BRIEF_PROMPT = """You write a production engineer's morning briefing from numbered facts. Field staff read it on a phone: short, plain, no jargon beyond oil and gas terms.
Write at most {n} bullets covering, in this order: what changed overnight, then the biggest production losses by BOE/day and dollars.
Do NOT write about safety or list decisions; both are shown separately. Do not tell people what they must do: report the facts.
Say "planned" when a fact says the work is planned. BOE/d and $/d figures are rates at risk per day, not volumes lost overnight. Use only the facts. Every number you write must appear in the facts you cite.
Return JSON: {{"bullets": [{{"text": "...", "facts": ["F3", "F7"]}}]}}"""


def register(app, query, S, llm, who, check_well, locked_ids):
    """Adds the production-issue, reason-code and briefing API to the FastAPI app."""

    # ---------------- reading ----------------
    def settings():
        s = {r["setting"]: r["value"] for r in query(f"SELECT setting, value FROM {S}.gold_issue_settings")}
        return {"approval_threshold_cad": float(s.get("approval_threshold_cad", 25000)), "approver_role": s.get("approver_role", "Production superintendent"),
                "repeat_failure_count": int(s.get("repeat_failure_count", 3)), "repeat_failure_days": int(s.get("repeat_failure_days", 90)),
                "verify_days": int(s.get("verify_days", 3))}

    def codes():
        return query(f"SELECT reason_code, label, reason_group, description FROM {S}.gold_reason_codes ORDER BY reason_group, label")

    def as_of():
        return str(query(f"SELECT max(prod_date) d FROM {S}.gold_daily_well")[0]["d"])

    def all_issues(where="", params=None):
        return query(f"SELECT * EXCEPT (rn) FROM (SELECT *, row_number() OVER (PARTITION BY issue_id ORDER BY updated_at DESC) rn FROM {S}.app_production_issues {where}) WHERE rn = 1", params)

    def get_issue(issue_id):
        rows = all_issues("WHERE issue_id = :i", {"i": issue_id})
        if not rows: raise HTTPException(404, "No such issue")
        return rows[0]

    def event(issue_id, actor, action, detail=None, frm=None, to=None, data=None):
        query(f"INSERT INTO {S}.app_issue_events VALUES (:id, :iss, cast(:at AS TIMESTAMP), :actor, :action, :frm, :to, :detail, :dj)",
              {"id": "IE-" + uuid.uuid4().hex[:12], "iss": issue_id, "at": _ts(_now()), "actor": actor, "action": action, "frm": frm, "to": to,
               "detail": _txt(detail, 4000), "dj": json.dumps(data, default=str) if data is not None else None})

    COLS = ["issue_id", "well_id", "engineer_id", "title", "source", "rule_ids", "state", "lost_bopd", "value_cad_day", "baseline_oil_bopd", "expected_oil_bopd",
            "triage_result", "diagnosis", "fix_type", "fix_plan", "est_cost_cad", "approval", "scheduled_date", "work_order", "fix_done_date", "fix_done_note",
            "reason_code", "lost_oil_bbl", "lost_boe", "actual_cost_cad", "outcome", "outcome_note", "dismissed_reason",
            "opened_by", "opened_at", "updated_by", "updated_at"]
    CASTS = {**{c: f"cast(:{c} AS DOUBLE)" for c in ("lost_bopd", "value_cad_day", "baseline_oil_bopd", "expected_oil_bopd", "est_cost_cad", "lost_oil_bbl", "lost_boe", "actual_cost_cad")},
             **{c: f"cast(:{c} AS DATE)" for c in ("scheduled_date", "fix_done_date")},
             **{c: f"cast(:{c} AS TIMESTAMP)" for c in ("opened_at", "updated_at")}}

    def save(rec, actor):
        rec = dict(rec, updated_by=actor, updated_at=_ts(_now()))
        def v(x):
            if isinstance(x, datetime): return _ts(x)
            if isinstance(x, date): return x.isoformat()
            return x
        query(f"INSERT INTO {S}.app_production_issues ({', '.join(COLS)}) VALUES ({', '.join(CASTS.get(c, ':' + c) for c in COLS)})",
              {c: v(rec.get(c)) for c in COLS})

    def snapshot(well_id=None):
        w = "WHERE well_id = :w" if well_id else ""
        return query(f"SELECT * FROM {S}.gold_well_snapshot {w}", {"w": well_id} if well_id else None)

    def boe(oil, gor):
        return None if oil is None else oil * (1 + (gor or 0) / 6000)

    def verification(iss, cfg):
        """Compares production after the fix with the type-curve rate. Says so plainly when there isn't enough data yet."""
        if not iss.get("fix_done_date"): return None
        rows = query(f"""SELECT prod_date, oil_bbl, target_oil_bopd, reported, dq_sensor_error FROM {S}.gold_daily_well
                         WHERE well_id = :w AND prod_date > cast(:d AS DATE) ORDER BY prod_date""", {"w": iss["well_id"], "d": str(iss["fix_done_date"])[:10]})
        good = [r for r in rows if r["reported"] and not r["dq_sensor_error"] and r["oil_bbl"] is not None]
        last = as_of()
        out = {"fix_done_date": str(iss["fix_done_date"])[:10], "days_after": len(good), "needed": cfg["verify_days"], "data_through": last,
               "baseline_oil_bopd": iss.get("baseline_oil_bopd"), "source": f"{S}.gold_daily_well"}
        bad = len(rows) - len(good)
        if len(good) < cfg["verify_days"]:
            out.update(status="waiting", text=f"Not enough production data after the fix to verify it: {len(good)} good day(s) since {out['fix_done_date']}, "
                                               f"{cfg['verify_days']} needed. Production data runs to {last}." + (f" {bad} day(s) skipped for missing or bad data." if bad else ""))
            return out
        rate = sum(r["oil_bbl"] for r in good) / len(good)
        exp = sum(r["target_oil_bopd"] or 0 for r in good) / len(good)
        ratio = rate / exp if exp else None
        base = iss.get("baseline_oil_bopd")
        if ratio is not None and ratio >= 0.9: status, word = "back", "Back to expected"
        elif base is not None and rate > base * 1.05: status, word = "better", "Better than before the fix, still below expected"
        else: status, word = "not_better", "Not better than before the fix"
        out.update(status=status, post_oil_bopd=round(rate, 1), expected_oil_bopd=round(exp, 1), ratio=None if ratio is None else round(ratio, 2),
                   text=f"{word}: {rate:,.1f} bbl/d oil over {len(good)} day(s) after the fix vs {exp:,.1f} expected"
                        + (f" and {base:,.1f} before" if base is not None else "") + f" (data through {last})." + (f" {bad} day(s) skipped for missing or bad data." if bad else ""))
        return out

    def suggested_outcome(ver):
        if not ver or ver["status"] == "waiting": return None
        return {"back": "Fixed", "better": "Partly fixed", "not_better": "Not fixed"}[ver["status"]]

    def repeats(well_id=None):
        w = "AND well_id = :w" if well_id else ""
        return query(f"SELECT * FROM {S}.gold_v_repeat_failures WHERE stops > 0 {w} ORDER BY stops DESC, lost_boe DESC", {"w": well_id} if well_id else None)

    # ---------------- reason codes, repeat failures, lost production ----------------
    @app.get("/api/downtime")
    def downtime(engineer_id: str = None, days: int = 90):
        days = max(7, min(int(days), 180))
        eng = "AND engineer_id = :e" if engineer_id and engineer_id != "ALL" else ""
        pe = {"e": engineer_id} if eng else {}
        p = dict(pe, d=days)
        by_cause = query(f"""SELECT reason_code, first(reason_label) reason_label, first(reason_group) reason_group, count(*) stops, count(DISTINCT well_id) wells,
                                    round(sum(hours_lost), 0) hours, round(sum(lost_oil_bbl), 0) lost_oil_bbl, round(sum(lost_boe), 0) lost_boe, round(sum(lost_value_cad), 0) lost_value_cad,
                                    bool_or(planned) any_planned, count_if(is_open) still_down
                             FROM {S}.gold_v_downtime_coded
                             WHERE event_date > date_sub((SELECT max(prod_date) FROM {S}.gold_daily_well), cast(:d AS INT)) {eng}
                             GROUP BY reason_code ORDER BY lost_boe DESC NULLS LAST""", p)
        rep = query(f"""SELECT r.*, s.lift_type FROM {S}.gold_v_repeat_failures r LEFT JOIN {S}.gold_well_dim s USING (well_id)
                        WHERE r.repeat {eng.replace('engineer_id', 'r.engineer_id')} ORDER BY r.stops DESC, r.lost_boe DESC""", pe)
        unmapped = query(f"SELECT count(*) n FROM {S}.gold_v_downtime_coded WHERE reason_code = 'OTHER' {eng}", pe)[0]["n"]
        return {"as_of": as_of(), "days": days, "by_cause": by_cause, "repeat_failures": rep, "codes": codes(), "settings": settings(), "unmapped": unmapped,
                "method": "Lost oil = hours down / 24 x the well's expected (type-curve) oil rate that day. BOE adds gas at the day's GOR (6 mcf = 1 BOE). "
                          "Dollars use the price assumptions after royalty. These are estimates, not measured volumes.",
                "sources": [f"{S}.gold_v_downtime_coded", f"{S}.gold_v_repeat_failures", f"{S}.gold_reason_code_map", f"{S}.gold_price_assumptions"]}

    @app.get("/api/downtime/well/{well_id}")
    def downtime_well(well_id: str):
        check_well(well_id)
        ev = query(f"""SELECT event_date, hours_lost, is_open, planned, reason_original, reason_code, reason_label, lost_oil_bbl, lost_boe, lost_value_cad, _source_file
                       FROM {S}.gold_v_downtime_coded WHERE well_id = :w ORDER BY event_start DESC LIMIT 40""", {"w": well_id})
        return {"events": ev, "repeats": repeats(well_id), "settings": settings(), "as_of": as_of()}

    @app.post("/api/reason-codes")
    async def save_code(request: Request):
        """Operations edits the standard list. Codes are never deleted (old records still point at them)."""
        b, actor = await request.json(), who(request)
        code = (_txt(b.get("reason_code"), 40) or "").upper().replace(" ", "-")
        label, group = _txt(b.get("label"), 120), _txt(b.get("reason_group"), 40)
        if not re.fullmatch(r"[A-Z0-9-]{2,40}", code or ""): raise HTTPException(400, "Code is 2-40 letters, numbers or dashes, e.g. ROD-PART.")
        if not label or not group: raise HTTPException(400, "Give the code a label and a group.")
        existing = {c["reason_code"]: c for c in codes()}
        p = {"c": code, "l": label, "g": group, "d": _txt(b.get("description"), 400)}
        if code in existing: query(f"UPDATE {S}.gold_reason_codes SET label = :l, reason_group = :g, description = :d WHERE reason_code = :c", p)
        else: query(f"INSERT INTO {S}.gold_reason_codes VALUES (:c, :l, :g, :d)", p)
        query(f"INSERT INTO {S}.app_issue_events VALUES (:id, 'REASON-CODES', cast(:at AS TIMESTAMP), :actor, :action, NULL, NULL, :detail, :dj)",
              {"id": "IE-" + uuid.uuid4().hex[:12], "at": _ts(_now()), "actor": actor, "action": "Reason code changed" if code in existing else "Reason code added",
               "detail": f"{code}: {label} ({group})", "dj": json.dumps({"before": existing.get(code), "after": p})})
        return {"ok": True, "codes": codes()}

    # ---------------- issues ----------------
    @app.get("/api/issues")
    def list_issues(engineer_id: str = None):
        cfg = settings()
        iss = all_issues()
        if engineer_id and engineer_id != "ALL": iss = [i for i in iss if i["engineer_id"] == engineer_id]
        events = query(f"SELECT * FROM {S}.app_issue_events WHERE issue_id <> 'REASON-CODES' ORDER BY at")
        snap = {r["well_id"]: r for r in snapshot()}
        rep = {}
        for r in repeats():
            if r["repeat"]: rep.setdefault(r["well_id"], []).append({"reason_code": r["reason_code"], "reason_label": r["reason_label"], "stops": r["stops"]})
        out = []
        for i in iss:
            s = snap.get(i["well_id"]) or {}
            out.append(dict(i, rule_ids=json.loads(i["rule_ids"] or "[]"), well_name=s.get("well_name"), events=[e for e in events if e["issue_id"] == i["issue_id"]],
                            needs_approval=(i["est_cost_cad"] or 0) >= cfg["approval_threshold_cad"], repeats=rep.get(i["well_id"], []),
                            verification=verification(i, cfg) if i["state"] in ("Verifying", "Closed") else None,
                            now_lost_bopd=s.get("lost_oil_bopd"), now_value_cad_day=s.get("value_at_risk_cad_day")))
        order = {st: n for n, st in enumerate(STATES + [DISMISSED])}
        out.sort(key=lambda x: (x["state"] in ("Closed", DISMISSED), -(x["value_cad_day"] or 0), order.get(x["state"], 0)))
        return {"issues": out, "states": STATES, "next": NEXT, "fix_types": FIX_TYPES, "outcomes": OUTCOMES, "codes": codes(), "settings": cfg, "as_of": as_of()}

    @app.post("/api/issues")
    async def open_issue(request: Request):
        """Opens an issue from a flag (or by hand). A flag on a well that already has an open issue is merged into it."""
        b, actor = await request.json(), who(request)
        well = check_well(b.get("well_id"))
        rule_ids = [str(r)[:80] for r in (b.get("rule_ids") or ([b["rule_id"]] if b.get("rule_id") else []))]
        if any(r in locked_ids for r in rule_ids):
            raise HTTPException(400, "Safety flags are handled as safety incidents, not production issues. Use 'Report safety incident'.")
        title = _txt(b.get("title"), 300) or "Production issue"
        mine = [i for i in all_issues("WHERE well_id = :w", {"w": well}) if i["state"] in OPEN_STATES]
        if mine:
            iss = mine[0]
            have = json.loads(iss["rule_ids"] or "[]")
            new = [r for r in rule_ids if r not in have]
            if new:
                save(dict(iss, rule_ids=json.dumps(have + new)), actor)
                event(iss["issue_id"], actor, "Flag merged", f"Another flag on this well was merged into the open issue instead of opening a new one: {title}.", data={"rule_ids": new})
            return {"issue_id": iss["issue_id"], "merged": True, "new_flags": new}
        s = (snapshot(well) or [{}])[0]
        now = _now()
        iss = {"issue_id": "ISS-" + now.strftime("%Y%m%d") + "-" + uuid.uuid4().hex[:4].upper(), "well_id": well, "engineer_id": s.get("engineer_id"),
               "title": title, "source": b.get("source") if b.get("source") in ("flag", "manual", "morning call") else "manual", "rule_ids": json.dumps(rule_ids),
               "state": "Detected", "lost_bopd": s.get("lost_oil_bopd"), "value_cad_day": s.get("value_at_risk_cad_day"),
               "baseline_oil_bopd": s.get("oil_7d_bopd"), "expected_oil_bopd": s.get("target_7d_bopd"), "opened_by": actor, "opened_at": now}
        save(iss, actor)
        event(iss["issue_id"], actor, "Opened", f"{title}. At detection ({s.get('as_of_date')}, {S}.gold_well_snapshot): oil {_f(s.get('oil_7d_bopd'), 1)} bbl/d vs "
                                                f"{_f(s.get('target_7d_bopd'), 1)} expected, {_f(s.get('lost_oil_bopd'), 1)} bbl/d lost, ${_f(s.get('value_at_risk_cad_day'))}/day at risk.",
              to="Detected", data={"rule_ids": rule_ids, "snapshot": {k: s.get(k) for k in ("as_of_date", "oil_7d_bopd", "target_7d_bopd", "lost_oil_bopd", "value_at_risk_cad_day")}})
        return {"issue_id": iss["issue_id"], "merged": False}

    @app.post("/api/issues/{issue_id}/transition")
    async def transition(issue_id: str, request: Request):
        b, actor = await request.json(), who(request)
        iss, to, cfg = get_issue(issue_id), b.get("to"), settings()
        frm = iss["state"]
        note = _txt(b.get("note"), 4000)
        upd = dict(iss, state=to)
        if to == DISMISSED:
            if frm in ("Closed", DISMISSED): raise HTTPException(400, f"It is already {frm.lower()}.")
            if not note: raise HTTPException(400, "Say why it isn't a real issue (for example a meter or data error).")
            upd["dismissed_reason"] = note
            if b.get("data_error"): upd["reason_code"] = "DATA-ERROR"
        elif to not in NEXT.get(frm, []):
            raise HTTPException(400, f"From {frm} the next step is {' or '.join(NEXT.get(frm, [])) or 'nothing'}.")
        elif to == "Triaged":
            if not note: raise HTTPException(400, "Record the triage: is it real, and how urgent?")
            upd["triage_result"] = note
        elif to == "Fix Planned":
            diag, ft, plan, cost = _txt(b.get("diagnosis"), 4000), b.get("fix_type"), _txt(b.get("fix_plan"), 4000), _num(b.get("est_cost_cad"), "Estimated cost")
            if frm in ("Diagnosing", "Triaged"):
                if not diag: raise HTTPException(400, "Record the diagnosis: what is causing it.")
                if ft not in FIX_TYPES: raise HTTPException(400, "Pick the kind of fix.")
                if not plan: raise HTTPException(400, "Describe the fix plan.")
                if cost is None: raise HTTPException(400, "Give an estimated cost (0 if none).")
                upd.update(diagnosis=diag, fix_type=ft, fix_plan=plan, est_cost_cad=cost, approval=None)
            else:  # sent back from Awaiting Approval: the plan changes
                if plan: upd["fix_plan"] = plan
                if cost is not None: upd["est_cost_cad"] = cost
                upd["approval"] = None
        elif to == "Awaiting Approval":
            if (iss["est_cost_cad"] or 0) < cfg["approval_threshold_cad"]:
                raise HTTPException(400, f"Fixes under ${cfg['approval_threshold_cad']:,.0f} don't need approval. Schedule it.")
        elif to == "Scheduled":
            if (iss["est_cost_cad"] or 0) >= cfg["approval_threshold_cad"] and not str(iss.get("approval") or "").startswith("Approved"):
                raise HTTPException(400, f"This fix is estimated at ${iss['est_cost_cad']:,.0f}, at or above the ${cfg['approval_threshold_cad']:,.0f} limit. "
                                         f"The {cfg['approver_role']} must approve it first.")
            d = _date(b.get("scheduled_date"), "Scheduled date")
            if not d: raise HTTPException(400, "Pick the date the work is scheduled for.")
            upd["scheduled_date"] = d
            upd["work_order"] = _txt(b.get("work_order"), 80) or iss.get("work_order")
        elif to == "In Progress":
            upd["work_order"] = _txt(b.get("work_order"), 80) or iss.get("work_order")
        elif to == "Verifying":
            d = _date(b.get("fix_done_date"), "Date the fix was finished")
            if not d: raise HTTPException(400, "When was the fix finished?")
            if d > date.today(): raise HTTPException(400, "The fix date can't be in the future.")
            if not note: raise HTTPException(400, "Say what was done.")
            upd.update(fix_done_date=d, fix_done_note=note)
        elif to == "Closed":
            rc, lost, cost, out = b.get("reason_code"), _num(b.get("lost_oil_bbl"), "Lost oil"), _num(b.get("actual_cost_cad"), "Actual cost"), b.get("outcome")
            if rc not in {c["reason_code"] for c in codes()}: raise HTTPException(400, "Pick a standard reason code.")
            if lost is None: raise HTTPException(400, "Give the lost oil volume (bbl), 0 if none.")
            if cost is None: raise HTTPException(400, "Give the actual cost, 0 if none.")
            if out not in OUTCOMES: raise HTTPException(400, "Pick the outcome.")
            s = (snapshot(iss["well_id"]) or [{}])[0]
            upd.update(reason_code=rc, lost_oil_bbl=lost, lost_boe=round(boe(lost, s.get("gor_7d")), 1), actual_cost_cad=cost, outcome=out, outcome_note=note)
            ai = b.get("ai_decision")
            if ai in ("accepted", "edited", "rejected"):
                event(issue_id, actor, f"AI close-out {ai}", {"accepted": "Used the AI's pre-filled close-out as suggested.", "edited": "Used the AI's pre-filled close-out after changing it.",
                                                             "rejected": "Did not use the AI's pre-filled close-out."}[ai],
                      data={"suggested": b.get("ai_suggestion"), "final": {"reason_code": rc, "lost_oil_bbl": lost, "actual_cost_cad": cost, "outcome": out}})
        elif to == "Diagnosing" and frm in ("Verifying", "Closed"):
            if not note: raise HTTPException(400, "Say why it needs more work.")
            upd.update(fix_done_date=None, fix_done_note=None, outcome=None)
        save(upd, actor)
        event(issue_id, actor, "Reopened" if frm in ("Closed", DISMISSED) else "State changed",
              note or b.get("diagnosis") or b.get("fix_plan") or (f"Scheduled for {b.get('scheduled_date')}" if to == "Scheduled" else None), frm=frm, to=to,
              data={k: b.get(k) for k in ("fix_type", "est_cost_cad", "scheduled_date", "work_order", "fix_done_date", "reason_code", "lost_oil_bbl", "actual_cost_cad", "outcome") if b.get(k) not in (None, "")})
        return {"ok": True, "state": to}

    @app.post("/api/issues/{issue_id}/approval")
    async def approval(issue_id: str, request: Request):
        """Records the approver's decision. In this demo anyone can record it on the approver's behalf; it is logged with who did."""
        b, actor = await request.json(), who(request)
        iss, cfg = get_issue(issue_id), settings()
        if iss["state"] != "Awaiting Approval": raise HTTPException(400, "This issue isn't waiting for approval.")
        d, by, note = b.get("decision"), _txt(b.get("approver"), 120), _txt(b.get("note"), 1000)
        if d not in ("Approved", "Rejected"): raise HTTPException(400, "Approved or Rejected?")
        if not by: raise HTTPException(400, f"Name the {cfg['approver_role']} who decided.")
        txt = f"{d} by {by}" + (f": {note}" if note else "")
        save(dict(iss, approval=txt, state="Fix Planned" if d == "Rejected" else iss["state"]), actor)
        event(issue_id, actor, f"Fix {d.lower()}", txt + f" (recorded by {actor})", frm="Awaiting Approval", to="Fix Planned" if d == "Rejected" else None,
              data={"decision": d, "approver": by, "est_cost_cad": iss["est_cost_cad"]})
        return {"ok": True}

    @app.post("/api/issues/{issue_id}/notes")
    async def note(issue_id: str, request: Request):
        b, actor = await request.json(), who(request)
        get_issue(issue_id)
        t = _txt(b.get("note"), 4000)
        if not t: raise HTTPException(400, "Empty note")
        event(issue_id, actor, _txt(b.get("kind"), 40) or "Note", t)
        return {"ok": True}

    @app.post("/api/issues/{issue_id}/close-suggest")
    def close_suggest(issue_id: str, request: Request):
        """Pre-fills the close-out for a person to confirm. Volume, cost and outcome come from the data; the AI only picks the reason code
        (with the words that support it) and drafts the outcome note."""
        iss, actor, cfg = get_issue(issue_id), who(request), settings()
        if iss["state"] != "Verifying": raise HTTPException(400, "Close-out is pre-filled once the fix is being verified.")
        ver = verification(iss, cfg)
        # Lost oil from the production data: the run of days below 90% of the type curve that ends at the fix, shortfall summed.
        end = str(iss["fix_done_date"])[:10]
        daily = query(f"""SELECT prod_date, oil_bbl, target_oil_bopd, reported, dq_sensor_error FROM {S}.gold_daily_well
                          WHERE well_id = :w AND prod_date <= cast(:d AS DATE) AND prod_date > date_sub(cast(:d AS DATE), 60) ORDER BY prod_date DESC""", {"w": iss["well_id"], "d": end})
        run, lost = [], 0.0
        for r in daily:
            if not r["reported"] or r["dq_sensor_error"] or r["oil_bbl"] is None or not r["target_oil_bopd"]: continue
            if r["oil_bbl"] >= 0.9 * r["target_oil_bopd"]: break
            run.append(str(r["prod_date"])); lost += r["target_oil_bopd"] - r["oil_bbl"]
        lost = round(lost, 0)
        why = {"lost_oil_bbl": (f"Shortfall against the type curve over the {len(run)} day(s) below 90% of it, {run[-1]} to {run[0]}, up to the fix ({S}.gold_daily_well). An estimate: change it if you have measured volumes."
                                if run else f"Production wasn't below 90% of the type curve in the days before the fix on {end}, so no loss shows in the data. Enter it if you know it."),
               "actual_cost_cad": "From the fix plan's estimate. Replace with the actual invoiced cost.",
               "outcome": ver["text"] if ver else "No verification yet."}
        sug = {"lost_oil_bbl": lost, "actual_cost_cad": iss["est_cost_cad"], "outcome": suggested_outcome(ver), "reason_code": None, "outcome_note": None, "why": why}
        events = query(f"SELECT at, actor, action, detail FROM {S}.app_issue_events WHERE issue_id = :i ORDER BY at", {"i": issue_id})
        record = "\n".join([f"Title: {iss['title']}", f"Triage: {iss['triage_result'] or ''}", f"Diagnosis: {iss['diagnosis'] or ''}", f"Fix type: {iss['fix_type'] or ''}",
                            f"Fix plan: {iss['fix_plan'] or ''}", f"What was done: {iss['fix_done_note'] or ''}", f"Verification: {why['outcome']}", "Thread:"]
                           + [f"- {e['action']}: {e['detail'] or ''}" for e in events if e["detail"]])
        cl = codes()
        used = []
        try:
            out = alerts._json(alerts._ask(llm, [{"role": "system", "content": CLOSE_PROMPT.format(codes="\n".join(f"{c['reason_code']}: {c['label']} - {c['description']}" for c in cl))},
                                                 {"role": "user", "content": record}], 500, used, alerts.DRAFT_MODEL))
            rc, q = out.get("reason_code"), re.sub(r"\s+", " ", str(out.get("quote") or "")).strip().lower()
            if rc in {c["reason_code"] for c in cl} and q and q in re.sub(r"\s+", " ", record.lower()):
                sug["reason_code"], why["reason_code"] = rc, f"The AI matched this to the record's words: \"{out.get('quote')}\"."
            else:
                why["reason_code"] = "The AI couldn't tie a reason code to words in the record. Pick one."
            nums = set(re.findall(r"\d[\d,]*\.?\d*", record))
            on = _txt(out.get("outcome_note"), 600)
            if on and all(n.replace(",", "") in {x.replace(",", "") for x in nums} for n in re.findall(r"\d[\d,]*\.?\d*", on)):
                sug["outcome_note"] = on
        except Exception as e:  # noqa: BLE001 - the close-out never depends on the AI
            why["reason_code"] = f"The AI wasn't available ({str(e)[:80]}). Pick a reason code."
        sug["model"] = used[0][0] if used else None
        event(issue_id, actor, "AI close-out suggested", "Pre-filled the close-out for a person to confirm. Not applied until someone closes the issue.", data=sug)
        return sug

    # ---------------- morning briefing and call ----------------
    @app.post("/api/briefing")
    async def briefing(request: Request):
        """Facts first, from the records. Safety lines are written by the app. The AI writes the rest from numbered facts and every number is checked."""
        b = await request.json()
        eng = b.get("engineer_id") or "ALL"
        ranked = [r for r in (b.get("ranking") or []) if isinstance(r, dict)][:60]
        snap = {r["well_id"]: r for r in snapshot() if eng == "ALL" or r["engineer_id"] == eng}
        day = as_of()
        facts, n = [], [0]

        def fact(kind, text, source, well_id=None, ref=None):
            n[0] += 1
            f = {"id": f"F{n[0]}", "kind": kind, "text": text, "source": source, "well_id": well_id, "ref": ref}
            facts.append(f)
            return f["id"]

        # 1. Safety, always first, written by the app.
        safety = []
        incs = query(f"SELECT * EXCEPT (rn) FROM (SELECT *, row_number() OVER (PARTITION BY incident_id ORDER BY updated_at DESC) rn FROM {S}.app_safety_incidents) WHERE rn = 1 AND state <> 'Closed'")
        for i in sorted(incs, key=lambda x: str(x["reported_at"])):
            if eng != "ALL" and i["well_id"] not in snap: continue
            t = f"Open safety incident {i['incident_id']}: {i['category']} at {i['location']}, now {i['state']}. Anyone hurt: {i['people_hurt']}. Reported {str(i['reported_at'])[:16]} UTC."
            safety.append({"text": t, "facts": [fact("safety", t, f"{S}.app_safety_incidents (updated {str(i['updated_at'])[:16]} UTC)", i["well_id"], i["incident_id"])],
                           "kind": "incident", "ref": i["incident_id"], "well_id": i["well_id"]})
        review = []
        for r in ranked:
            if r.get("safety_flag") in (None, "none") or r.get("well_id") not in snap: continue
            if r["safety_flag"] == "Review":  # review-level items are grouped into one line, never dropped
                review.append(r); continue
            names = ", ".join(f["rule"] for f in (r.get("flags") or []) if f.get("safety"))[:300] or "safety rule"
            t = f"{r['well_id']} {snap[r['well_id']]['well_name']}: {r['safety_flag']} safety flag ({names})."
            safety.append({"text": t, "facts": [fact("safety", t, f"flag rules on {S}.gold_v_well_safety, as of {day}", r["well_id"])], "kind": "well", "ref": r["well_id"], "well_id": r["well_id"]})

        if review:
            t = f"{len(review)} well(s) with review-level safety items: " + "; ".join(f"{r['well_id']} ({', '.join(f['rule'] for f in (r.get('flags') or []) if f.get('safety'))[:80]})" for r in review) + "."
            safety.append({"text": t, "facts": [fact("safety", t, f"flag rules on {S}.gold_v_well_safety, as of {day}")], "kind": "group", "ref": None, "well_id": None})

        # 2. What changed overnight (the last day of data).
        ev = query(f"""SELECT well_id, well_name, hours_lost, is_open, planned, reason_label, lost_boe, lost_value_cad FROM {S}.gold_v_downtime_coded
                       WHERE event_date = cast(:d AS DATE) ORDER BY lost_boe DESC NULLS LAST""", {"d": day})
        ev = [e for e in ev if e["well_id"] in snap]
        if ev:
            top = ev[:5]
            fact("overnight", f"{len(ev)} downtime event(s) on {day}, {_f(sum(e['lost_boe'] or 0 for e in ev))} BOE lost (estimate). Largest: "
                 + "; ".join(f"{e['well_id']} {e['reason_label']} {_f(e['hours_lost'], 1)} h, {_f(e['lost_boe'], 1)} BOE" for e in top) + ".",
                 f"{S}.gold_v_downtime_coded, {day}")
        down = [s for s in snap.values() if (s["consecutive_down_days"] or 0) >= 1]
        for s in sorted(down, key=lambda x: -(x["value_at_risk_cad_day"] or 0))[:6]:
            fact("overnight", f"{s['well_id']} {s['well_name']} is down{' for planned work' if s['open_event_planned'] else ''}, {s['consecutive_down_days']} day(s) in a row ({s['open_event_reason'] or 'no reason recorded'}), "
                 f"{_f(boe(s['lost_oil_bopd'], s['gor_7d']), 1)} BOE/d and ${_f(s['value_at_risk_cad_day'])}/d at risk.", f"{S}.gold_well_snapshot, {day}", s["well_id"])
        stale = [s for s in snap.values() if (s["days_since_last_data"] or 0) >= 2]
        if stale:
            fact("data", f"No production data for 2+ days on {len(stale)} well(s): " + ", ".join(f"{s['well_id']} ({s['days_since_last_data']} d)" for s in stale[:8])
                 + ". Their numbers may be out of date.", f"{S}.gold_well_snapshot, {day}")
        recent = query(f"""SELECT e.issue_id, e.action, e.to_state, e.at FROM {S}.app_issue_events e WHERE e.at > current_timestamp() - INTERVAL 24 HOURS
                           AND e.issue_id <> 'REASON-CODES' ORDER BY e.at""")

        # 3. Production issues and the biggest losses.
        iss = [i for i in all_issues() if (eng == "ALL" or i["engineer_id"] == eng)]
        open_iss = sorted([i for i in iss if i["state"] in OPEN_STATES], key=lambda i: -((snap.get(i["well_id"]) or {}).get("value_at_risk_cad_day") or i["value_cad_day"] or 0))
        for i in open_iss[:6]:
            s = snap.get(i["well_id"]) or {}
            fact("issue", f"Issue {i['issue_id']} on {i['well_id']} {s.get('well_name', '')}: {i['title']}, now {i['state']}. "
                 f"{_f(boe(s.get('lost_oil_bopd'), s.get('gor_7d')), 1)} BOE/d and ${_f(s.get('value_at_risk_cad_day'))}/d at risk.",
                 f"{S}.app_production_issues + gold_well_snapshot, {day}", i["well_id"], i["issue_id"])
        in_issue = {i["well_id"] for i in open_iss}
        top_wells = [r for r in ranked if r.get("well_id") in snap and r.get("tier") != "handled" and r["well_id"] not in in_issue and (r.get("safety_flag") in (None, "none"))]
        top_wells = sorted(top_wells, key=lambda r: -(snap[r["well_id"]]["value_at_risk_cad_day"] or 0))[:5]
        for r in top_wells:
            s = snap[r["well_id"]]
            fact("well", f"{s['well_id']} {s['well_name']} has no open issue yet: {_f(boe(s['lost_oil_bopd'], s['gor_7d']), 1)} BOE/d and ${_f(s['value_at_risk_cad_day'])}/d at risk. "
                 f"Flags: {', '.join(f['rule'] for f in (r.get('flags') or [])[:3])}.", f"{S}.gold_well_snapshot, {day}", s["well_id"])
        rep = [x for x in repeats() if x["repeat"] and x["well_id"] in snap][:5]
        if rep:
            fact("repeat", "Repeat failures (last 90 days): " + "; ".join(f"{x['well_id']} {x['reason_label']} x{x['stops']}" for x in rep) + ".", f"{S}.gold_v_repeat_failures, {day}")

        # 4. Decisions needed.
        decisions = []
        for i in open_iss:
            d = None
            if i["state"] == "Awaiting Approval": d = f"Approve or reject the ${_f(i['est_cost_cad'])} fix on {i['well_id']} ({i['issue_id']})."
            elif i["state"] == "Fix Planned": d = f"Schedule the fix on {i['well_id']} ({i['issue_id']})."
            elif i["state"] == "Detected": d = f"Triage the new issue on {i['well_id']} ({i['issue_id']}): real or not, and how urgent."
            elif i["state"] == "Verifying": d = f"Close out or rework the fix on {i['well_id']} ({i['issue_id']})."
            if d: decisions.append({"text": d, "facts": [fact("decision", d, f"{S}.app_production_issues", i["well_id"], i["issue_id"])], "kind": "issue", "ref": i["issue_id"], "well_id": i["well_id"]})
        for r in [x for x in top_wells if x.get("tier") == "production" and not snap[x["well_id"]]["open_event_planned"]][:3]:
            d = f"Open an issue for {r['well_id']} or say why not."
            decisions.append({"text": d, "facts": [fact("decision", d, f"{S}.gold_well_snapshot, {day}", r["well_id"])], "kind": "well", "ref": r["well_id"], "well_id": r["well_id"]})

        # AI summary of the non-safety facts, with every number checked.
        nonsafety = [f for f in facts if f["kind"] not in ("safety", "decision")]
        bullets, dropped, used, ai_note = [], 0, [], None
        if nonsafety:
            try:
                out = alerts._json(alerts._ask(llm, [{"role": "system", "content": BRIEF_PROMPT.format(n=6)},
                                                     {"role": "user", "content": "\n".join(f"{f['id']}: {f['text']}" for f in nonsafety)}], 900, used, alerts.DRAFT_MODEL))
                byid = {f["id"]: f for f in nonsafety}
                for bl in (out.get("bullets") or [])[:6]:
                    text, ids = _txt(bl.get("text"), 400), [i for i in (bl.get("facts") or []) if i in byid]
                    src = " ".join(byid[i]["text"] for i in ids).replace(",", "")
                    nums = [x.replace(",", "").rstrip(".") for x in re.findall(r"\d[\d,]*\.?\d*", text or "")]
                    if text and ids and all(x in src for x in nums): bullets.append({"text": text, "facts": ids})
                    else: dropped += 1
            except Exception as e:  # noqa: BLE001 - the briefing never depends on the AI
                ai_note = f"The AI summary wasn't available ({str(e)[:80]}), so these are the facts as recorded."
        if not bullets:
            bullets = [{"text": f["text"], "facts": [f["id"]]} for f in nonsafety if f["kind"] in ("overnight", "issue", "data", "repeat")][:8]
            ai_note = ai_note or ("The AI summary didn't pass the number check, so these are the facts as recorded." if dropped else None)
        return {"as_of": day, "generated_at": _ts(_now())[:16] + " UTC", "engineer_id": eng, "safety": safety, "summary": bullets, "decisions": decisions,
                "facts": facts, "dropped": dropped, "ai_note": ai_note, "model": used[0][0] if used else None, "recent_activity": len(recent),
                "method": "Facts come from the tables named on each one. Safety lines are written by the app, never the AI. AI lines are dropped if a number in them is not in the facts they cite."}

    @app.post("/api/morning-calls")
    async def save_call(request: Request):
        """Saves the call, and writes each item's notes and decisions into the issue or incident record it was about."""
        b, actor = await request.json(), who(request)
        items = [i for i in (b.get("items") or []) if isinstance(i, dict) and (_txt(i.get("note")) or _txt(i.get("decision")))]
        if not items: raise HTTPException(400, "Nothing to save: add a note or decision to at least one item.")
        cid, now, written = "MC-" + _now().strftime("%Y%m%d") + "-" + uuid.uuid4().hex[:4].upper(), _now(), []
        for it in items:
            text = "; ".join(x for x in [f"Decision: {_txt(it.get('decision'), 1000)}" if _txt(it.get("decision")) else None,
                                         f"Note: {_txt(it.get('note'), 2000)}" if _txt(it.get("note")) else None] if x)
            kind, ref = it.get("kind"), _txt(it.get("ref"), 80)
            if kind == "issue" and ref:
                get_issue(ref)
                event(ref, actor, "Morning call", text + f" ({cid})")
                written.append(ref)
            elif kind == "incident" and ref:
                query(f"INSERT INTO {S}.app_incident_events VALUES (:id, :inc, cast(:at AS TIMESTAMP), :actor, 'Morning call', NULL, NULL, :detail, NULL)",
                      {"id": "EV-" + uuid.uuid4().hex[:12], "inc": ref, "at": _ts(now), "actor": actor, "detail": text + f" ({cid})"})
                written.append(ref)
            elif kind == "well" and ref and it.get("open_issue"):
                check_well(ref)
                res = await open_issue_direct(ref, _txt(it.get("decision"), 300) or f"Raised at the morning call {cid}", actor)
                event(res["issue_id"], actor, "Morning call", text + f" ({cid})")
                written.append(res["issue_id"])
        query(f"INSERT INTO {S}.app_morning_calls VALUES (:id, :e, cast(:d AS DATE), :bj, :ij, :by, cast(:at AS TIMESTAMP))",
              {"id": cid, "e": b.get("engineer_id") or "ALL", "d": b.get("call_date") or str(date.today()), "bj": json.dumps(b.get("briefing"), default=str)[:200000],
               "ij": json.dumps(items, default=str), "by": actor, "at": _ts(now)})
        return {"call_id": cid, "written_to": written}

    async def open_issue_direct(well, title, actor):
        class _R:
            headers = {"x-forwarded-email": actor}
            async def json(self): return {"well_id": well, "title": title, "source": "morning call"}
        return await open_issue(_R())

    @app.get("/api/morning-calls")
    def list_calls(engineer_id: str = None):
        rows = query(f"SELECT call_id, engineer_id, call_date, items_json, started_by, saved_at FROM {S}.app_morning_calls ORDER BY saved_at DESC LIMIT 20")
        return {"calls": [dict(r, items=json.loads(r.pop("items_json") or "[]")) for r in rows if not engineer_id or engineer_id == "ALL" or r["engineer_id"] in (engineer_id, "ALL")]}
