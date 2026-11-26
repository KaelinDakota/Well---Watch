"""Safety incident lifecycle: Reported -> Made Safe -> Notified -> Under Investigation -> Corrective Actions Open -> Closed.

Rules this module keeps (from the app's operating principles):
- Safety comes first. Reporting is a few fields and notifies the on-call chain at once; nothing waits on the AI.
- People move an incident from state to state. The app and the AI never close, downgrade or delay one.
- Notifications are simulated in this demo: recorded with who, which channel and when, not actually sent.
  An unacknowledged report escalates automatically on the configured schedule.
- The AI only helps structure the record from the reporter's own words. Every field it suggests must quote
  the text it came from; a person accepts, edits or rejects the suggestion, and that decision is logged.
- The app only ever says a regulatory report MAY be required, from configured prompts. A qualified person
  records the decision. The app never says a report is not required.
- Everything is append-only and every action goes to app_incident_events: who knew what, and when.
"""
import json
import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, Request

import alerts

STATES = ["Reported", "Made Safe", "Notified", "Under Investigation", "Corrective Actions Open", "Closed"]
CATEGORIES = ["H2S release or alarm", "Spill or release", "Gas release", "Fire or explosion", "Injury", "Near miss", "Equipment failure", "Other"]
HURT = ["Yes", "No", "Unknown"]
# Demo company emergency line (reserved 555-01xx range). Replace with the operator's real number.
EMERGENCY_LINE = "+1 403 555 0100"
SYSTEM_ACTOR = "Well Watch (automatic)"


def _now():
    return datetime.now(timezone.utc)


def _ts(d):
    return d.strftime("%Y-%m-%d %H:%M:%S.%f")


def _parse(v):
    if v is None: return None
    s = str(v).replace("T", " ").replace("Z", "")
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try: return datetime.strptime(s[:26], fmt).replace(tzinfo=timezone.utc)
        except ValueError: pass
    return None


def _txt(v, n=2000):
    v = (v or "").strip() if isinstance(v, str) else v
    return None if v in (None, "") else str(v)[:n]


STRUCTURE_PROMPT = """You help structure a safety incident report from oil and gas field staff. Use ONLY the reporter's text.
Return one JSON object:
{"what": ..., "where": ..., "when": ..., "who_involved": ..., "substance": ..., "volume_m3": ..., "people_hurt": "Yes"|"No"|"Unknown",
 "timeline": [{"time": ..., "event": ...}], "missing": ["information a safety investigator would need that the text does not give"],
 "quotes": {"what": "...", "where": "...", "when": "...", "who_involved": "...", "substance": "...", "volume_m3": "...", "people_hurt": "..."}}
Rules: every field you fill must have, under "quotes", the exact words from the text it came from (copy them exactly).
If the text does not say something, set the field to null and leave its quote out. Never guess, never infer causes, never add facts.
volume_m3 is a number in cubic metres only if the text gives a volume in m3; otherwise null. people_hurt is "Unknown" unless the text says.
Do not say whether anything must be reported to a regulator."""


def register(app, query, S, llm, who, check_well):
    """Adds the incident API to the FastAPI app."""

    # ---------------- reading ----------------
    def latest(table, key):
        return query(f"SELECT * EXCEPT (rn) FROM (SELECT *, row_number() OVER (PARTITION BY {key} ORDER BY updated_at DESC) rn FROM {S}.{table}) WHERE rn = 1")

    def oncall():
        return query(f"SELECT step, role, channels, after_minutes, reason FROM {S}.gold_incident_oncall ORDER BY step, role")

    def prompts_cfg():
        return query(f"SELECT * FROM {S}.gold_reporting_prompts ORDER BY prompt_id")

    def contacts(well_id):
        return query(f"SELECT role, full_name, email, mobile FROM {S}.gold_well_contacts WHERE well_id = :w", {"w": well_id})

    def event(incident_id, actor, action, detail=None, frm=None, to=None, data=None, at=None):
        query(f"INSERT INTO {S}.app_incident_events VALUES (:id, :inc, cast(:at AS TIMESTAMP), :actor, :action, :frm, :to, :detail, :dj)",
              {"id": "EV-" + uuid.uuid4().hex[:12], "inc": incident_id, "at": _ts(at or _now()), "actor": actor, "action": action,
               "frm": frm, "to": to, "detail": _txt(detail, 4000), "dj": json.dumps(data, default=str) if data is not None else None})

    def save_incident(rec, actor):
        cols = ["incident_id", "well_id", "area", "category", "what_happened", "people_hurt", "substance", "volume_m3", "occurred_at", "location", "state",
                "made_safe_note", "investigation_lead", "root_cause", "closing_note", "regulatory_decision", "regulatory_decided_by", "source_rule_id",
                "reported_by", "reported_at", "updated_by", "updated_at"]
        rec = dict(rec, updated_by=actor, updated_at=_ts(_now()))
        casts = {"volume_m3": "cast(:volume_m3 AS DOUBLE)", "occurred_at": "cast(:occurred_at AS TIMESTAMP)", "reported_at": "cast(:reported_at AS TIMESTAMP)", "updated_at": "cast(:updated_at AS TIMESTAMP)"}
        query(f"INSERT INTO {S}.app_safety_incidents ({', '.join(cols)}) VALUES ({', '.join(casts.get(c, ':' + c) for c in cols)})",
              {c: (None if rec.get(c) is None else (_ts(rec[c]) if isinstance(rec.get(c), datetime) else rec.get(c))) for c in cols})

    def get_incident(incident_id):
        rows = query(f"SELECT * EXCEPT (rn) FROM (SELECT *, row_number() OVER (PARTITION BY incident_id ORDER BY updated_at DESC) rn FROM {S}.app_safety_incidents WHERE incident_id = :i) WHERE rn = 1", {"i": incident_id})
        if not rows: raise HTTPException(404, "No such incident")
        return rows[0]

    def notify(incident, step_rows, actor, at, escalation=False):
        """Records (simulates) a notification to every person in these on-call steps."""
        people = contacts(incident["well_id"])
        sent = []
        for st in step_rows:
            for p in [c for c in people if c["role"] == st["role"]]:
                nid = "NT-" + uuid.uuid4().hex[:12]
                query(f"""INSERT INTO {S}.app_incident_notifications VALUES (:id, :inc, cast(:step AS INT), :role, :person, :email, :mobile, :ch, 'Sent',
                          cast(:at AS TIMESTAMP), NULL, NULL, true, cast(:at AS TIMESTAMP))""",
                      {"id": nid, "inc": incident["incident_id"], "step": st["step"], "role": st["role"], "person": p["full_name"], "email": p["email"],
                       "mobile": p["mobile"], "ch": st["channels"], "at": _ts(at)})
                sent.append(f"{p['full_name']} ({st['role']}) by {st['channels'].replace(',', ', ')}")
        if sent:
            event(incident["incident_id"], actor, "Escalated" if escalation else "Notified on-call chain",
                  ("No one acknowledged in time, so the alert went to: " if escalation else "Alert sent to: ") + "; ".join(sent) + ". Simulated in this demo: recorded, not actually sent.",
                  data={"step": step_rows[0]["step"] if step_rows else None, "recipients": sent, "simulated": True}, at=at)
        return sent

    def escalate(incidents, notes, chain):
        """Sends any escalation step that is due: nobody acknowledged and the step's time has passed. Never changes the state."""
        now, changed = _now(), False
        for inc in incidents:
            if inc["state"] == "Closed": continue
            mine = [n for n in notes if n["incident_id"] == inc["incident_id"]]
            if any(n["status"] == "Acknowledged" for n in mine): continue
            reported = _parse(inc["reported_at"])
            if not reported: continue
            sent_steps = {n["step"] for n in mine}
            for step in sorted({c["step"] for c in chain}):
                if step in sent_steps: continue
                rows = [c for c in chain if c["step"] == step]
                due = reported + timedelta(minutes=rows[0]["after_minutes"])
                if due <= now:
                    # Sent now, when the app sees it is due (any page load or refresh checks). A scheduled job would send it on the minute.
                    notify(inc, rows, SYSTEM_ACTOR, now, escalation=step > 1)
                    changed = True
        return changed

    def reporting_prompts(inc, cfg):
        out = []
        for p in cfg:
            if p["applies_to"] not in ("*", inc["category"]): continue
            if p["min_volume_m3"] is not None and (inc["volume_m3"] or 0) < p["min_volume_m3"]: continue
            if p["when_injury"] is not None and p["when_injury"] and inc["people_hurt"] != "Yes": continue
            out.append({"prompt_id": p["prompt_id"], "text": p["prompt"], "decided_by_role": p["decided_by_role"]})
        return out

    def next_escalation(inc, mine, chain):
        if inc["state"] == "Closed" or any(n["status"] == "Acknowledged" for n in mine): return None
        reported, sent = _parse(inc["reported_at"]), {n["step"] for n in mine}
        for step in sorted({c["step"] for c in chain}):
            if step not in sent:
                c = [x for x in chain if x["step"] == step]
                return {"step": step, "at": _ts(reported + timedelta(minutes=c[0]["after_minutes"])), "roles": [x["role"] for x in c]}
        return None

    @app.get("/api/incidents")
    def list_incidents():
        chain, cfg = oncall(), prompts_cfg()
        incs = latest("app_safety_incidents", "incident_id")
        notes = latest("app_incident_notifications", "notification_id")
        if escalate(incs, notes, chain):
            notes = latest("app_incident_notifications", "notification_id")
        actions = latest("app_corrective_actions", "action_id")
        events = query(f"SELECT * FROM {S}.app_incident_events ORDER BY at")
        out = []
        for inc in incs:
            i = inc["incident_id"]
            mine = sorted([n for n in notes if n["incident_id"] == i], key=lambda n: (n["step"], n["role"], n["person"]))
            out.append(dict(inc,
                            notifications=mine,
                            acknowledged=any(n["status"] == "Acknowledged" for n in mine),
                            next_escalation=next_escalation(inc, mine, chain),
                            actions=sorted([a for a in actions if a["incident_id"] == i], key=lambda a: str(a["due_date"])),
                            events=[e for e in events if e["incident_id"] == i],
                            reporting_prompts=reporting_prompts(inc, cfg)))
        out.sort(key=lambda x: (x["state"] == "Closed", str(x["reported_at"])), reverse=False)
        open_first = [x for x in out if x["state"] != "Closed"][::-1] + [x for x in out if x["state"] == "Closed"][::-1]
        return {"incidents": open_first, "states": STATES, "categories": CATEGORIES, "oncall": chain, "prompts": cfg, "now": _ts(_now()), "emergency_line": EMERGENCY_LINE}

    @app.get("/api/incidents/emergency/{well_id}")
    def emergency(well_id: str):
        check_well(well_id)
        people = contacts(well_id)
        want = ["Field foreman", "HSE advisor", "Production superintendent"]
        return {"emergency_line": EMERGENCY_LINE,
                "contacts": [{"role": p["role"], "name": p["full_name"], "mobile": p["mobile"]} for r in want for p in people if p["role"] == r]}

    # ---------------- reporting ----------------
    @app.post("/api/incidents")
    async def report(request: Request):
        b = await request.json()
        well = check_well(b.get("well_id"))
        cat, text, hurt = b.get("category"), _txt(b.get("what_happened"), 4000), b.get("people_hurt") or "Unknown"
        if cat not in CATEGORIES: raise HTTPException(400, "Pick what kind of safety issue it is.")
        if not text: raise HTTPException(400, "Say what happened, in a few words.")
        if hurt not in HURT: raise HTTPException(400, "Is anyone hurt? Yes, No or Unknown.")
        vol = b.get("volume_m3")
        try: vol = None if vol in (None, "") else float(vol)
        except (TypeError, ValueError): raise HTTPException(400, "Volume must be a number of cubic metres.")
        actor, now = who(request), _now()
        dim = query(f"SELECT well_name, area FROM {S}.gold_well_dim WHERE well_id = :w", {"w": well})
        area = dim[0]["area"] if dim else None
        inc = {"incident_id": "INC-" + now.strftime("%Y%m%d") + "-" + uuid.uuid4().hex[:4].upper(), "well_id": well, "area": area, "category": cat,
               "what_happened": text, "people_hurt": hurt, "substance": _txt(b.get("substance"), 200), "volume_m3": vol,
               "occurred_at": _parse(b.get("occurred_at")) or now, "location": f"{well} {dim[0]['well_name']} ({area} area)" if dim else well,
               "state": "Reported", "source_rule_id": _txt(b.get("source_rule_id"), 80), "reported_by": actor, "reported_at": now}
        save_incident(inc, actor)
        event(inc["incident_id"], actor, "Reported", f"{cat} at {inc['location']}. Anyone hurt: {hurt}. In the reporter's words: {text}", to="Reported",
              data={k: inc[k] for k in ("category", "people_hurt", "substance", "volume_m3", "source_rule_id")}, at=now)
        chain = oncall()
        sent = notify(inc, [c for c in chain if c["after_minutes"] == 0], SYSTEM_ACTOR, now)
        return {"incident_id": inc["incident_id"], "notified": sent}

    # ---------------- moving through the states ----------------
    @app.post("/api/incidents/{incident_id}/transition")
    async def transition(incident_id: str, request: Request):
        b, actor = await request.json(), who(request)
        inc, to = get_incident(incident_id), b.get("to")
        if to not in STATES: raise HTTPException(400, "Unknown state")
        frm = inc["state"]
        note = _txt(b.get("note"), 4000)
        reopening = frm == "Closed" and to == "Under Investigation"
        if not reopening and STATES.index(to) != STATES.index(frm) + 1:
            raise HTTPException(400, f"From {frm} the next step is {STATES[STATES.index(frm) + 1] if frm != 'Closed' else 'reopening it'}.")
        notes = [n for n in latest("app_incident_notifications", "notification_id") if n["incident_id"] == incident_id]
        acts = [a for a in latest("app_corrective_actions", "action_id") if a["incident_id"] == incident_id]
        upd = dict(inc, state=to)
        if to == "Made Safe":
            if not note: raise HTTPException(400, "Say what was done to make the area safe.")
            upd["made_safe_note"] = note
        elif to == "Notified":
            if not any(n["status"] == "Acknowledged" for n in notes): raise HTTPException(400, "Wait until at least one person in the on-call chain has acknowledged the alert.")
        elif to == "Under Investigation":
            lead = _txt(b.get("investigation_lead"), 200)
            if not lead: raise HTTPException(400, "Name the person leading the investigation.")
            upd["investigation_lead"] = lead
        elif to == "Corrective Actions Open":
            rc = _txt(b.get("root_cause"), 4000)
            if not rc: raise HTTPException(400, "Record the root cause found by the investigation.")
            if not acts: raise HTTPException(400, "Add at least one corrective action, with an owner and a due date.")
            upd["root_cause"] = rc
        elif to == "Closed":
            if not note: raise HTTPException(400, "Add a closing note.")
            open_acts = [a for a in acts if a["status"] != "Done"]
            if open_acts: raise HTTPException(400, f"{len(open_acts)} corrective action(s) are still open. Close them first.")
            # When a reporting prompt matched, a qualified person must have recorded a final decision first.
            if reporting_prompts(inc, prompts_cfg()) and (not inc.get("regulatory_decision") or str(inc["regulatory_decision"]).startswith("Still deciding")):
                raise HTTPException(400, "A reporting prompt matched this incident. A qualified person must record the regulatory decision before it can be closed.")
            upd["closing_note"] = note
        save_incident(upd, actor)
        event(incident_id, actor, "Reopened" if reopening else "State changed", note or b.get("investigation_lead") or b.get("root_cause"), frm=frm, to=to)
        return {"ok": True, "state": to}

    @app.post("/api/incidents/{incident_id}/acknowledge")
    async def acknowledge(incident_id: str, request: Request):
        """In production the recipient taps Acknowledge on their phone. In this demo someone records it on their behalf."""
        b, actor = await request.json(), who(request)
        nid = b.get("notification_id")
        rows = [n for n in latest("app_incident_notifications", "notification_id") if n["notification_id"] == nid and n["incident_id"] == incident_id]
        if not rows: raise HTTPException(404, "No such notification")
        n, now = rows[0], _now()
        if n["status"] == "Acknowledged": return {"ok": True}
        by = f"{n['person']} (recorded by {actor}, simulated)"
        query(f"""INSERT INTO {S}.app_incident_notifications VALUES (:id, :inc, cast(:step AS INT), :role, :person, :email, :mobile, :ch, 'Acknowledged',
                  cast(:sent AS TIMESTAMP), cast(:at AS TIMESTAMP), :by, true, cast(:at AS TIMESTAMP))""",
              {"id": n["notification_id"], "inc": incident_id, "step": n["step"], "role": n["role"], "person": n["person"], "email": n["email"], "mobile": n["mobile"],
               "ch": n["channels"], "sent": str(n["sent_at"]), "at": _ts(now), "by": by})
        event(incident_id, actor, "Acknowledged", f"{n['person']} ({n['role']}) acknowledged the alert. Simulated in this demo.", data={"notification_id": nid}, at=now)
        return {"ok": True}

    @app.post("/api/incidents/{incident_id}/notes")
    async def add_note(incident_id: str, request: Request):
        b, actor = await request.json(), who(request)
        get_incident(incident_id)
        text = _txt(b.get("text"), 4000)
        if not text: raise HTTPException(400, "Write the note first.")
        event(incident_id, actor, "Note", text)
        return {"ok": True}

    # ---------------- corrective actions ----------------
    @app.post("/api/incidents/{incident_id}/actions")
    async def add_action(incident_id: str, request: Request):
        b, actor = await request.json(), who(request)
        inc = get_incident(incident_id)
        if inc["state"] == "Closed": raise HTTPException(400, "Reopen the incident to add actions.")
        desc, owner, due = _txt(b.get("description"), 1000), _txt(b.get("owner"), 200), _txt(b.get("due_date"), 10)
        if not desc or not owner or not due or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", due): raise HTTPException(400, "A corrective action needs what to do, an owner and a due date.")
        aid = "CA-" + uuid.uuid4().hex[:8].upper()
        query(f"INSERT INTO {S}.app_corrective_actions VALUES (:id, :inc, :d, :o, cast(:due AS DATE), 'Open', NULL, :by, cast(:at AS TIMESTAMP))",
              {"id": aid, "inc": incident_id, "d": desc, "o": owner, "due": due, "by": actor, "at": _ts(_now())})
        event(incident_id, actor, "Corrective action added", f"{desc} · owner {owner} · due {due}", data={"action_id": aid})
        return {"ok": True, "action_id": aid}

    @app.post("/api/incidents/{incident_id}/actions/{action_id}")
    async def update_action(incident_id: str, action_id: str, request: Request):
        b, actor = await request.json(), who(request)
        rows = [a for a in latest("app_corrective_actions", "action_id") if a["action_id"] == action_id and a["incident_id"] == incident_id]
        if not rows: raise HTTPException(404, "No such action")
        a, status = rows[0], b.get("status")
        if status not in ("Open", "Done"): raise HTTPException(400, "Status is Open or Done")
        note = _txt(b.get("note"), 1000)
        if status == "Done" and not note: raise HTTPException(400, "Say how it was done.")
        query(f"INSERT INTO {S}.app_corrective_actions VALUES (:id, :inc, :d, :o, cast(:due AS DATE), :st, :n, :by, cast(:at AS TIMESTAMP))",
              {"id": action_id, "inc": incident_id, "d": a["description"], "o": a["owner"], "due": str(a["due_date"]), "st": status, "n": note, "by": actor, "at": _ts(_now())})
        event(incident_id, actor, "Corrective action " + ("done" if status == "Done" else "reopened"), f"{a['description']}" + (f" · {note}" if note else ""), data={"action_id": action_id})
        return {"ok": True}

    # ---------------- regulatory decision: a qualified person, never the app ----------------
    @app.post("/api/incidents/{incident_id}/regulatory")
    async def regulatory(incident_id: str, request: Request):
        b, actor = await request.json(), who(request)
        inc = get_incident(incident_id)
        decision, name, reason = b.get("decision"), _txt(b.get("decided_by"), 200), _txt(b.get("reason"), 2000)
        if decision not in ("Report made to the regulator", "Decided no report needed", "Still deciding"): raise HTTPException(400, "Pick a decision")
        if not name or not reason: raise HTTPException(400, "Record who made the decision and why.")
        save_incident(dict(inc, regulatory_decision=f"{decision}: {reason}", regulatory_decided_by=name), actor)
        event(incident_id, actor, "Regulatory decision recorded", f"{decision}, decided by {name}: {reason}")
        return {"ok": True}

    # ---------------- AI: structure the record from the reporter's words ----------------
    @app.post("/api/incidents/{incident_id}/structure")
    def structure(incident_id: str, request: Request):
        inc, actor = get_incident(incident_id), who(request)
        text, used = inc["what_happened"] or "", []
        try:
            out = alerts._json(alerts._ask(llm, [{"role": "system", "content": STRUCTURE_PROMPT}, {"role": "user", "content": text}], 1200, used, alerts.DRAFT_MODEL))
        except Exception as e:  # noqa: BLE001 - the report itself never depends on the AI
            raise HTTPException(502, f"The AI couldn't structure this report ({e}). Fill in the fields by hand.")
        low = re.sub(r"\s+", " ", text.lower())
        quotes = out.get("quotes") or {}
        kept, dropped = {}, []
        for k in ("what", "where", "when", "who_involved", "substance", "volume_m3", "people_hurt"):
            v = out.get(k)
            if v in (None, "", "Unknown") and k == "people_hurt": kept[k] = "Unknown"; continue
            if v in (None, ""): continue
            q = re.sub(r"\s+", " ", str(quotes.get(k) or "").lower()).strip()
            ok = bool(q) and q in low
            if k == "volume_m3":
                try: v = float(v)
                except (TypeError, ValueError): ok = False
                ok = ok and re.search(r"(?<![\d.])" + re.escape(f"{v:g}") + r"(?![\d])", low) is not None
            if ok: kept[k] = {"value": v, "quote": quotes.get(k)}
            else: dropped.append(k)
        timeline = [t for t in (out.get("timeline") or []) if isinstance(t, dict) and t.get("event")][:12]
        suggestion = {"fields": kept, "timeline": timeline, "missing": [str(m) for m in (out.get("missing") or [])][:10], "dropped": dropped,
                      "model": used[0][0] if used else None, "secs": used[0][1] if used else None}
        event(incident_id, actor, "AI suggestion made", "The AI suggested a structured record from the report text" + (f"; it dropped {', '.join(dropped)} because the text didn't support them" if dropped else "") + ". Not applied until a person accepts it.",
              data=suggestion)
        return suggestion

    @app.post("/api/incidents/{incident_id}/structure/decision")
    async def structure_decision(incident_id: str, request: Request):
        b, actor = await request.json(), who(request)
        inc = get_incident(incident_id)
        decision, fields = b.get("decision"), b.get("fields") or {}
        if decision not in ("accepted", "edited", "rejected"): raise HTTPException(400, "Decision is accepted, edited or rejected")
        if decision != "rejected":
            upd = dict(inc)
            if fields.get("substance") not in (None, ""): upd["substance"] = _txt(fields["substance"], 200)
            if fields.get("volume_m3") not in (None, ""):
                try: upd["volume_m3"] = float(fields["volume_m3"])
                except (TypeError, ValueError): raise HTTPException(400, "Volume must be a number")
            if fields.get("people_hurt") in HURT: upd["people_hurt"] = fields["people_hurt"]
            save_incident(upd, actor)
        event(incident_id, actor, f"AI suggestion {decision}", {"accepted": "Applied the AI's structured record as suggested.", "edited": "Applied the AI's structured record after editing it.",
                                                               "rejected": "Rejected the AI's structured record; nothing was changed."}[decision], data={"fields": fields, "summary": b.get("summary")})
        return {"ok": True}
