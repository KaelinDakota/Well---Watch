"""Agent alert workflow.

1. A flag is raised (the ranking in the browser found it; the server re-reads the well's facts itself).
2. Recipients come from data, not the model: gold_alert_routing says which roles hear about this kind of flag,
   gold_well_contacts says who holds those roles for this well's area.
3. Greg (drafting agent) writes an email, a Teams message and a text from the facts.
4. The checker (oversight agent) reviews the drafts: deterministic checks (every number appears in the facts, well named,
   next step and due date present, no claims that anything was done) plus a model review for accuracy, tone and audience.
   If anything fails, Greg revises once with the checker's notes and the checks run again.
5. Nothing is sent. The engineer edits and approves; approval creates a follow-up task (app_alert_tasks)."""
import json, re, time

import requests
from datetime import date, timedelta

import agent

TODAY = date(2026, 11, 23)
SIM_FIELDS = {"casing_psi_max_7d", "casing_pct_of_maasp", "casing_psi_change", "casing_psi_7d"}
DUE_DAYS = {"Critical": 1, "Warning": 3, "Review": 7}
CHANNELS = {"Critical": ["email", "teams", "text"], "Warning": ["email", "teams"], "Review": ["email"]}
FACT_KEYS = ["well_id", "well_name", "area", "pad", "reservoir", "lift_type", "sour_class", "oil_7d_bopd", "perf_ratio_7d", "water_cut_7d_pct", "uptime_14d_pct",
             "consecutive_down_days", "value_at_risk_cad_day", "casing_psi_7d", "casing_psi_max_7d", "casing_psi_change", "prod_casing_maasp_psi", "casing_pct_of_maasp",
             "sc_psi_max_7d", "surface_casing_limit_psi", "sc_pct_of_limit", "flowline_psi_max_7d", "flowline_maop_psi", "flowline_pct_of_maop", "h2s_ppm_gas",
             "h2s_ambient_max_7d_ppm", "epz_m", "residences_in_epz", "tests_overdue", "critical_tests_overdue", "open_safety_events", "vent_pct_of_limit", "scvf_status"]

GREG = """You are Greg, the alerting agent in Well Watch, an internal production engineering app at Ridgeline Resources (all data is synthetic).
A flag was raised on a well. Write the alert the production engineer will send. You write drafts only; a person approves them.
Use ONLY the facts provided. Never add a number, cause, diagnosis or action that is not in the facts. Never say anything has been done, fixed, shut in or is safe.
Return a JSON object with exactly these keys and nothing else:
  "email_subject": short, starts with the severity and well id, e.g. "Critical: W-012 casing pressure near MAASP"
  "email_body": plain text. Greet the primary recipient by first name. First line: what was found, on which well, how bad (reading vs limit and when). The limit is the rule threshold in facts.flag.rule_thresholds (flags_when gte means "at or above"), or an equipment limit such as MAASP or MAOP in the well facts. Never present the reading itself as the limit.
     Then: why it matters (one sentence, from the routing reason). If facts.flag.related_flags_same_problem is not empty, mention those findings in one sentence as supporting evidence. Then "Recommended next step:" with the flag's next step, noting it follows company procedures.
     Then what you are asking the primary recipient to do and by the due date. Then who else is copied and why. Then the well report link. Sign off with the engineer's name.
  "teams_message": 2 to 4 short lines for a Teams chat to the primary recipient: what, where, how bad, the ask and due date, report link.
  "text_message": one SMS under 300 characters: severity, well id and name, the reading vs limit, the ask, and "Details in Teams/email".
Plain language a field person understands. Sentence case. No emoji. No markdown."""

CHECKER = """You are the oversight agent in Well Watch. Another agent (Greg) drafted an alert about a flagged well. Review it against the facts.
Check: (1) every fact and number is supported by the facts; (2) nothing is invented (causes, actions taken, people, dates); (3) the urgency matches the severity,
neither overstated nor understated; (4) it names the well, the reading vs its limit, the recommended next step, the ask and the due date; (5) it is addressed to the right
people per the routing; (6) the text message is short and readable on a phone.
Return a JSON object: {"verdict": "pass" or "revise", "issues": ["specific problem and how to fix it", ...]}. Return "pass" with an empty list when it is good. Be strict but brief."""


import os
DRAFT_MODEL = os.getenv("ALERT_DRAFT_MODEL", "databricks-qwen3-next-80b-a3b-instruct")   # Greg: fast instruct model
CHECK_MODEL = os.getenv("ALERT_CHECK_MODEL", "databricks-gpt-oss-120b")                   # checker: a different, larger model
SHORT = {"databricks-qwen3-next-80b-a3b-instruct": "qwen3-next-80b", "databricks-gpt-oss-120b": "gpt-oss-120b"}


def _ask(llm, msgs, max_tokens, used, model):
    """One model call, capped at 20 s; if that endpoint is slow, retry once on the other model."""
    other = CHECK_MODEL if model == DRAFT_MODEL else DRAFT_MODEL
    t = time.time()
    try:
        out = llm(msgs, [], max_tokens=max_tokens, reasoning="low" if "gpt-oss" in model else None, timeout=20, model=model)
        used.append((SHORT.get(model, model), round(time.time() - t, 1)))
    except requests.exceptions.Timeout:
        out = llm(msgs, [], max_tokens=max_tokens, reasoning="low" if "gpt-oss" in other else None, timeout=40, model=other)
        used.append((f"{SHORT.get(other, other)} (fallback after 20 s)", round(time.time() - t, 1)))
    return _content(out)


def _content(out):
    m = out["choices"][0]["message"]; t = m.get("content")
    if isinstance(t, list): t = "".join(p.get("text", "") for p in t if isinstance(p, dict) and p.get("type") == "text")
    return t or ""


def _json(text):
    s, e = text.find("{"), text.rfind("}")
    if s < 0 or e < 0: raise ValueError("no JSON in model output")
    return json.loads(text[s:e + 1])


def recipients(query, S, well_id, rule):
    routes = query(f"SELECT * FROM {S}.gold_alert_routing ORDER BY priority")
    def hit(r):
        return (r["match_type"] == "rule" and r["match_value"] == rule.get("rule_id")) or (r["match_type"] == "group" and r["match_value"] == (rule.get("group") or "")) \
            or (r["match_type"] == "category" and r["match_value"] == (rule.get("category") or "")) or r["match_type"] == "default"
    route = next(r for r in routes if hit(r))
    roles = [x.strip() for x in route["roles"].split(",")]
    people = {r["role"]: r for r in query(f"SELECT * FROM {S}.gold_well_contacts WHERE well_id = :w", {"w": well_id})}
    sev = rule.get("severity") or "Warning"
    out = []
    for i, role in enumerate(roles):
        p = people.get(role)
        if p: out.append({"name": p["full_name"], "role": role, "email": p["email"], "mobile": p["mobile"], "teams": p["teams_upn"],
                          "primary": i == 0, "channels": CHANNELS[sev] if i == 0 else ["email"], "why": route["reason"] if i == 0 else f"copied as {role.lower()}"})
    eng = people.get("Production engineer")
    return out, route, eng


def facts_for(query, S, well_id, flag, simulated):
    snap = (query(f"SELECT * FROM {S}.gold_well_snapshot WHERE well_id = :w", {"w": well_id}) or [{}])[0]
    safe = (query(f"SELECT * FROM {S}.gold_v_well_safety WHERE well_id = :w", {"w": well_id}) or [{}])[0]
    row = {**snap, **safe}
    f = {k: row.get(k) for k in FACT_KEYS if row.get(k) is not None}
    sim = {k: float(v) for k, v in (simulated or {}).items() if k in SIM_FIELDS and isinstance(v, (int, float))}
    f.update(sim)
    flag_facts = {"rule": flag.get("rule_name"), "severity": flag.get("severity"), "category": flag.get("category"), "what_was_found": flag.get("message"),
                  "readings": [{"label": e.get("label"), "value": e.get("value")} for e in (flag.get("evidence") or [])[:8]],
                  "rule_thresholds": [{"measure": str(t.get("measure"))[:80], "flags_when": str(t.get("flags_when"))[:10], "value": t.get("value")} for t in (flag.get("thresholds") or [])[:6]],
                  "related_flags_same_problem": [{"rule": str(x.get("rule_name"))[:80], "what_was_found": str(x.get("message"))[:300]} for x in (flag.get("related") or [])[:4]],
                  "recommended_next_step": flag.get("action")}
    return {"well": f, "flag": flag_facts, "data_through": "2026-11-22", "simulated_reading": bool(sim)}


def _fact_numbers(obj, extra):
    vals = []
    def walk(x):
        if isinstance(x, bool) or x is None: return
        if isinstance(x, (int, float)): vals.append(float(x))
        elif isinstance(x, str): vals.extend(agent._numbers(x))
        elif isinstance(x, dict): [walk(v) for v in x.values()]
        elif isinstance(x, list): [walk(v) for v in x]
    walk(obj); walk(extra)
    return vals


def check(drafts, facts, recips, due, report_url, sev):
    """Deterministic checks the oversight agent always runs."""
    text_all = " ".join(str(drafts.get(k, "")) for k in ("email_subject", "email_body", "teams_message", "text_message"))
    extra = [due, report_url, [r["mobile"] for r in recips], "300", "24"]
    vals = _fact_numbers(facts, extra)
    bad_nums = sorted({n for n in agent._numbers(re.sub(r"https?://\S+", " ", text_all)) if not agent._matches(n, vals)})
    wid = facts["well"].get("well_id", "")
    named = [r["name"] for r in recips]
    others = [n for n in ("Travis", "Renee", "Dale", "Kim", "Amara", "Brent", "Sofia", "Jordan", "Cheryl", "Victor", "Laura") if n in text_all and not any(x.startswith(n) for x in named)]
    claims = re.findall(r"\b(has been|have been|was|were) (fixed|repaired|resolved|shut in|isolated|contained)\b|\bis safe\b|\bno risk\b", text_all, re.I)
    body = drafts.get("email_body", "")
    limits = [float(t["value"]) for t in facts["flag"].get("rule_thresholds", []) if isinstance(t.get("value"), (int, float)) or str(t.get("value")).replace(".", "", 1).isdigit()]
    limits += [float(facts["well"][k]) for k in ("prod_casing_maasp_psi", "flowline_maop_psi", "surface_casing_limit_psi") if facts["well"].get(k) is not None]
    quoted = [float(m.replace(",", "")) for m in re.findall(r"\b(?:limit|threshold)(?: of| is| at|:)?\s*(?:≥|>=|>|at or above|above)?\s*(\d[\d,]*\.?\d*)", text_all, re.I)]
    quoted += [float(m.replace(",", "")) for m in re.findall(r"of (?:its |the )?(\d[\d,]*\.?\d*) ?(?:psi|ppm)", text_all)]
    bad_lim = sorted({q for q in quoted if not agent._matches(q, limits)})
    res = [
        {"name": "Every number matches the well's data", "ok": not bad_nums, "detail": "All numbers found in the facts." if not bad_nums else "Not in the data: " + ", ".join(f"{n:g}" for n in bad_nums)},
        {"name": "Limits quoted match the rules", "ok": not bad_lim, "detail": "Limits match the rule thresholds and equipment limits." if not bad_lim else "Not a limit for this flag: " + ", ".join(f"{n:g}" for n in bad_lim)},
        {"name": "Names the well in every message", "ok": all(wid in str(drafts.get(k, "")) for k in ("email_subject", "email_body", "teams_message", "text_message")), "detail": wid},
        {"name": "Severity in the subject", "ok": sev.lower() in drafts.get("email_subject", "").lower(), "detail": sev},
        {"name": "Includes the recommended next step", "ok": "next step" in body.lower(), "detail": "Email has a next step section."},
        {"name": "Asks for action by the due date", "ok": due in body or _human(due) in body, "detail": f"Due {due}"},
        {"name": "Only addresses people from the routing", "ok": not others, "detail": "Recipients match routing." if not others else "Mentions people not routed: " + ", ".join(others)},
        {"name": "Claims nothing was done", "ok": not claims, "detail": "No claims of actions taken." if not claims else "Remove claims that something was done."},
        {"name": "Text message fits one SMS", "ok": 0 < len(drafts.get("text_message", "")) <= 320, "detail": f"{len(drafts.get('text_message', ''))} characters"},
        {"name": "Links the well report", "ok": report_url in body, "detail": "Report link in the email."},
    ]
    return res


def _human(d):
    y, m, dd = d.split("-"); return f"{['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][int(m) - 1]} {int(dd)}"


def draft(query, S, llm, body):
    well_id, flag = body["well_id"], body.get("flag") or {}
    rule = {"rule_id": flag.get("rule_id"), "group": flag.get("group"), "category": flag.get("category"), "severity": flag.get("severity")}
    recips, route, eng = recipients(query, S, well_id, rule)
    if not recips: raise ValueError("No contacts found for this well")
    facts = facts_for(query, S, well_id, flag, body.get("simulated"))
    sev = flag.get("severity") or "Warning"
    due = (TODAY + timedelta(days=DUE_DAYS.get(sev, 3))).isoformat()
    report_url = body.get("report_url") or ""
    brief = {"facts": facts, "routing_reason": route["reason"], "primary_recipient": recips[0], "copied": recips[1:], "due_date": due, "due_date_words": _human(due),
             "engineer": {"name": eng["full_name"] if eng else body.get("engineer_name"), "email": eng["email"] if eng else ""}, "well_report_link": report_url}
    if facts["simulated_reading"]: brief["note"] = "This alert comes from a simulated reading for a demo; write it as a normal alert."
    steps, used = [], []
    msgs = [{"role": "system", "content": GREG}, {"role": "user", "content": json.dumps(brief, default=str)}]
    drafts = _json(_ask(llm, msgs, 3000, used, DRAFT_MODEL))
    steps.append({"agent": "Greg", "action": "Drafted email, Teams message and text", "model": used[-1][0], "secs": used[-1][1]})
    checks = check(drafts, facts, recips, due, report_url, sev)
    review = _review(llm, brief, drafts, used)
    steps.append({"agent": "Checker", "action": f"Reviewed the drafts: {sum(c['ok'] for c in checks)} of {len(checks)} checks passed, model review {review['verdict']}", "issues": review.get("issues", []), "model": used[-1][0], "secs": used[-1][1]})
    revised = False
    problems = [f"{c['name']}: {c['detail']}" for c in checks if not c["ok"]] + (list(review.get("issues") or []) if review["verdict"] == "revise" else [])
    if problems:
        msgs += [{"role": "assistant", "content": json.dumps(drafts)},
                 {"role": "user", "content": "The oversight agent found these problems. Fix them and return the full corrected JSON:\n- " + "\n- ".join(problems)}]
        drafts = _json(_ask(llm, msgs, 3000, used, DRAFT_MODEL))
        revised = True
        steps.append({"agent": "Greg", "action": "Revised the drafts using the checker's notes", "model": used[-1][0], "secs": used[-1][1]})
        checks = check(drafts, facts, recips, due, report_url, sev)
        review = _review(llm, brief, drafts, used)
        steps.append({"agent": "Checker", "action": f"Re-checked: {sum(c['ok'] for c in checks)} of {len(checks)} checks passed, model review {review['verdict']}", "issues": review.get("issues", []), "model": used[-1][0], "secs": used[-1][1]})
    return {"recipients": recips, "route": route, "drafts": drafts, "checks": checks, "review": review, "revised": revised, "steps": steps, "facts": facts,
            "due_date": due, "severity": sev, "simulated": facts["simulated_reading"]}


def _review(llm, brief, drafts, used):
    try:
        out = _json(_ask(llm, [{"role": "system", "content": CHECKER}, {"role": "user", "content": json.dumps({"brief": brief, "drafts": drafts}, default=str)}], 2000, used, CHECK_MODEL))
        v = "pass" if str(out.get("verdict", "")).lower() == "pass" else "revise"
        return {"verdict": v, "issues": [str(i)[:300] for i in (out.get("issues") or [])][:6]}
    except Exception as e:  # the deterministic checks still stand
        return {"verdict": "unavailable", "issues": [f"Model review failed: {str(e)[:120]}"]}
