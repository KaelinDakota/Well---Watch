"""Synthetic well portfolio for 'today's top 10 wells'. Fictional operator, wells and engineers.
Writes raw source files (as a field data system would drop them) plus an answer key."""
import csv, json, math, os, random
from datetime import date, datetime, timedelta
import numpy as np

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dataset")
RAW = f"{OUT}/raw"
for d in ["scada", "downtime", "maintenance", "economics", "master"]:
    os.makedirs(f"{RAW}/{d}", exist_ok=True)
os.makedirs(f"{OUT}/answer_key", exist_ok=True)
rng = np.random.default_rng(11); random.seed(11)

START, END = date(2026, 5, 27), date(2026, 11, 22)          # data through yesterday; "today" = 2026-11-23
DAYS = [START + timedelta(d) for d in range((END - START).days + 1)]
N = len(DAYS)
OIL_PRICE, GAS_PRICE = 75.0, 2.5

ENGINEERS = [("ENG-1", "Priya Nair", 1, 60), ("ENG-2", "Marcus Bell", 61, 115),
             ("ENG-3", "Hannah Ostrowski", 116, 160), ("ENG-4", "Diego Ramirez", 161, 200)]
RES = {  # reservoir: (qi range, Di per year, b, GOR scf/bbl, water cut, area)
    "Montney":  ((250, 420), 0.95, 1.1, 2200, 0.18, "North"),
    "Duvernay": ((300, 500), 1.05, 1.2, 2600, 0.15, "West"),
    "Cardium":  ((90, 180), 0.45, 0.6, 700, 0.35, "South"),
    "Viking":   ((60, 140), 0.40, 0.5, 500, 0.45, "East"),
}
PADS = ["Kestrel", "Harrier", "Merlin", "Osprey", "Falcon", "Shrike", "Plover", "Heron", "Curlew", "Avocet",
        "Godwit", "Dunlin", "Tern", "Grebe", "Loon", "Snipe", "Rail", "Crane", "Ibis", "Egret"]

SCN = {  # well -> scenario
    "W-007": "S1", "W-015": "S2", "W-023": "S3", "W-031": "S6", "W-044": "S7", "W-052": "S8", "W-012": "S10", "W-013": "S10", "W-014": "S10",
    "W-066": "S1", "W-074": "S5", "W-081": "S2", "W-090": "S4", "W-097": "S3", "W-105": "S7", "W-110": "S9",
    "W-121": "S2", "W-129": "S5", "W-137": "S6", "W-144": "S1", "W-151": "S8", "W-156": "S9",
    "W-166": "S2", "W-173": "S3", "W-179": "S4", "W-185": "S5", "W-191": "S7", "W-196": "S8",
}
SCN_INFO = {
    "S1": ("ESP failure, well down", True, ["WELL_DOWN_UNPLANNED"]),
    "S2": ("Gradual underperformance vs type curve", True, ["UNDER_TYPE_CURVE"]),
    "S3": ("Water breakthrough", True, ["WATER_CUT_JUMP"]),
    "S4": ("Rising gas-oil ratio", True, ["GOR_RISING"]),
    "S5": ("Chronic short downtime (rod pump)", True, ["FREQUENT_DOWNTIME"]),
    "S6": ("Casing pressure rising (integrity)", True, ["CASING_PRESSURE_RISING"]),
    "S7": ("Uneconomic: operating cost above netback", True, ["NEGATIVE_MARGIN"]),
    "S8": ("SCADA communication gap (data stale)", True, ["DATA_STALE"]),
    "S9": ("Back from workover, flush production (benign)", False, []),
    "S10": ("Planned facility turnaround (benign)", False, []),
}

# ---------------- well master ----------------
wells = []
for eid, ename, a, b in ENGINEERS:
    for n in range(a, b + 1):
        wid = f"W-{n:03d}"
        res = random.choice(list(RES))
        s = SCN.get(wid)
        if s == "S1": res = random.choice(["Montney", "Duvernay"])
        if s == "S4": res = random.choice(["Montney", "Duvernay"])
        if s == "S5": res = random.choice(["Cardium", "Viking"])
        if s == "S10": res = "Cardium"
        lift = {"Montney": "ESP", "Duvernay": random.choice(["ESP", "Gas lift"]), "Cardium": "Rod pump", "Viking": "Rod pump"}[res]
        if s == "S1": lift = "ESP"
        pad = "Kestrel" if s == "S10" else random.choice(PADS)
        age_days = int(rng.integers(200, 1400)) if res in ("Cardium", "Viking") else int(rng.integers(150, 900))
        onprod = START - timedelta(days=age_days)
        qlo, qhi = RES[res][0]
        wells.append(dict(well_id=wid, res=res, lift=lift, pad=pad, area=RES[res][5], engineer_id=eid, engineer=ename,
                          onprod=onprod, qi=float(rng.uniform(qlo, qhi)), di=RES[res][1], b=RES[res][2],
                          gor=RES[res][3] * float(rng.uniform(0.85, 1.15)), wcut=min(0.8, RES[res][4] * float(rng.uniform(0.8, 1.2))),
                          perf=float(np.clip(rng.normal(1.0, 0.04), 0.9, 1.1)), scenario=s))

def target(w, d):
    t = (d - w["onprod"]).days / 365.0
    return w["qi"] / (1 + w["b"] * w["di"] * t) ** (1 / w["b"])

# make sure ordinary wells stay comfortably economic and above 25 bbl/d
for w in wells:
    if target(w, END) < 28 and w["scenario"] not in ("S7",):
        w["qi"] *= 28 / target(w, END) * 1.1

# ---------------- daily truth ----------------
day_idx = {d: i for i, d in enumerate(DAYS)}
rows, downtime, workorders = [], [], []
for w in wells:
    s = w["scenario"]
    perf = np.full(N, w["perf"]); hours = np.full(N, 24.0)
    wcut = np.full(N, w["wcut"]) + rng.normal(0, 0.008, N)
    gor = np.full(N, w["gor"]) * (1 + rng.normal(0, 0.02, N))
    casing = np.full(N, float(rng.uniform(180, 320))) + rng.normal(0, 6, N)
    present = np.ones(N, bool)
    ramp = lambda k: np.clip((np.arange(N) - (N - k)) / k, 0, 1)

    # ordinary random downtime: ~1 event a month, a few hours
    for i in range(N):
        if rng.random() < 1 / 32:
            h = float(rng.uniform(2, 9)); hours[i] -= h
            downtime.append((w["well_id"], DAYS[i], h, random.choice(["Power outage", "power bump - restarted", "Weather", "high line pressure", "Pumped off"]), False))
    if s == "S1":
        i0 = day_idx[date(2026, 11, 17)]; hours[i0:] = 0
        downtime.append((w["well_id"], DAYS[i0], None, random.choice(["ESP tripped - overload. Restart failed.", "ESP trip on underload, won't restart", "esp fail - no restart"]), False))
    if s == "S2": perf = perf * (1 - 0.33 * ramp(45))
    if s == "S3":
        wc0 = wcut.copy(); wcut = wc0 + (0.62 - wc0) * ramp(20); perf = perf * (1 - wc0[-1]) / (1 - wcut) * (1 - 0.0) * ((1 - wcut) / (1 - wc0))  # oil falls with water cut
    if s == "S4": gor = gor * (1 + 1.1 * ramp(30)); perf = perf * (1 - 0.1 * ramp(30))
    if s == "S5":
        for i in range(N - 14, N):
            if rng.random() < 0.6:
                h = float(rng.uniform(2, 6)); hours[i] -= h
                downtime.append((w["well_id"], DAYS[i], h, random.choice(["Rod pump - pumped off", "stuffing box leak", "pump off controller fault", "rod pump down - restarted", "polished rod clamp slipped"]), False))
    if s == "S6": casing = casing + 430 * ramp(20)
    if s == "S7": w["qi"] = w["qi"] * 0.12
    if s == "S8": present[-4:] = False
    if s == "S9":
        a, b_ = day_idx[date(2026, 11, 10)], day_idx[date(2026, 11, 19)]
        hours[a:b_] = 0; perf[b_:] = perf[b_:] * (1.35 - 0.05 * np.arange(N - b_))
        downtime.append((w["well_id"], DAYS[a], (b_ - a) * 24.0, "Planned workover - pump change", True))
        workorders.append(dict(wo_number=f"WO-{w['well_id'][2:]}-26-118", well_id=w["well_id"], wo_type="Workover", description="Replace downhole pump, tubing inspection",
                               start_date=str(DAYS[a]), end_date=str(DAYS[b_ - 1]), status="Closed"))
    if s == "S10":
        a, b_ = day_idx[date(2026, 11, 18)], N
        hours[a:] = 0
        downtime.append((w["well_id"], DAYS[a], None, "Planned facility turnaround - Kestrel battery", True))
    if s == "S1":
        workorders.append(dict(wo_number=f"WO-{w['well_id'][2:]}-26-131", well_id=w["well_id"], wo_type="Repair", description="ESP failure - assess for pump change",
                               start_date="", end_date="", status="Requested"))

    for i, d in enumerate(DAYS):
        if not present[i]: continue
        up = max(0.0, hours[i]) / 24
        tgt = target(w, d)
        oil = tgt * perf[i] * up * (1 + rng.normal(0, 0.03)) if up > 0 else 0.0
        water = oil * wcut[i] / max(0.05, 1 - wcut[i]) if oil > 0 else 0.0
        gas = oil * gor[i] / 1000 if oil > 0 else 0.0
        tub = (220 + 0.6 * oil + rng.normal(0, 8)) if up > 0 else float(rng.uniform(15, 40))
        rows.append(dict(well_id=w["well_id"], d=d, hours=round(max(0.0, hours[i]), 1), oil=round(oil, 1), gas=round(gas, 1), water=round(water, 1),
                         tub=round(tub, 0), cas=round(casing[i], 0)))

# ---------------- write raw files, with realistic messiness ----------------
def week_key(d): y, wk, _ = d.isocalendar(); return f"{y}-W{wk:02d}"
by_week = {}
for r in rows: by_week.setdefault(week_key(r["d"]), []).append(r)
weeks = sorted(by_week)
area_of = {w["well_id"]: w["area"] for w in wells}
resend_count = sensor_errors = 0
for k, wk in enumerate(weeks):
    out = []
    for r in by_week[wk]:
        rr = dict(r)
        if rng.random() < 0.002 and rr["oil"] > 0: rr["oil"] = -999.0; sensor_errors += 1          # sensor error code
        out.append(rr)
    if k > 0:   # resend ~2% of the previous week's rows with corrected values (late corrections)
        for r in by_week[weeks[k - 1]]:
            if rng.random() < 0.02 and r["oil"] > 0:
                rr = dict(r); rr["oil"] = round(r["oil"] * float(rng.uniform(0.97, 1.03)), 1); rr["_resend"] = True; out.append(rr); resend_count += 1
    with open(f"{RAW}/scada/scada_export_{wk}.csv", "w", newline="") as f:
        cw = csv.writer(f); cw.writerow(["UWI_ALIAS", "PROD_DATE", "HRS_ON", "OIL_BBL", "GAS_VOL", "GAS_UOM", "WATER_BBL", "TBG_PSI", "CSG_PSI"])
        for r in out:
            east = area_of[r["well_id"]] == "East"
            gas = round(r["gas"] / 35.3147, 3) if east else r["gas"]                               # East field system exports gas in e3m3
            cw.writerow([r["well_id"], r["d"].isoformat(), r["hours"], r["oil"], gas, "E3M3" if east else "MCF", r["water"], r["tub"], r["cas"]])

for m in sorted({d.strftime("%Y-%m") for d in DAYS}):
    with open(f"{RAW}/downtime/downtime_log_{m}.csv", "w", newline="") as f:
        cw = csv.writer(f); cw.writerow(["well", "event_start", "hours_lost", "reason_text", "planned_yn"])
        for wid, d, h, reason, planned in downtime:
            if d.strftime("%Y-%m") == m:
                cw.writerow([wid, f"{d.isoformat()} {random.randint(0, 23):02d}:{random.choice(['00', '15', '30', '45'])}", "" if h is None else round(h, 1),
                             reason if random.random() < 0.7 else reason.upper(), "Y" if planned else "N"])

with open(f"{RAW}/maintenance/maintenance_workorders.csv", "w", newline="") as f:
    cw = csv.DictWriter(f, fieldnames=["wo_number", "well_id", "wo_type", "description", "start_date", "end_date", "status"]); cw.writeheader(); cw.writerows(workorders)

# monthly lease operating expense (operator accounting extract)
for m in sorted({d.strftime("%Y-%m") for d in DAYS}):
    with open(f"{RAW}/economics/loe_{m}.csv", "w", newline="") as f:
        cw = csv.writer(f); cw.writerow(["well_id", "month", "loe_cad"])
        for w in wells:
            base = {"ESP": 21000, "Gas lift": 16000, "Rod pump": 9000}[w["lift"]]
            loe = base * float(rng.uniform(0.85, 1.15)) + (24000 if w["scenario"] == "S7" else 0)
            cw.writerow([w["well_id"], m, round(loe, 0)])

with open(f"{RAW}/master/well_master.csv", "w", newline="") as f:
    cw = csv.writer(f); cw.writerow(["well_id", "uwi", "well_name", "pad", "area", "reservoir", "lift_type", "on_production_date"])
    for w in wells:
        n = int(w["well_id"][2:])
        name = f"{w['pad']} {(n % 16) + 1}-{(n % 30) + 1}H"
        if rng.random() < 0.08: name = "  " + name.upper() + " "                                       # messy master data
        cw.writerow([w["well_id"], f"100/{(n % 16) + 1:02d}-{(n % 30) + 1:02d}-0{45 + n % 9}-0{5 + n % 3}W5/00", name, w["pad"], w["area"], w["res"], w["lift"], w["onprod"].isoformat()])
with open(f"{RAW}/master/type_curves.csv", "w", newline="") as f:
    cw = csv.writer(f); cw.writerow(["well_id", "qi_bopd", "di_per_year", "b_factor", "curve_source"])
    for w in wells: cw.writerow([w["well_id"], round(w["qi"], 1), w["di"], w["b"], f"{w['res']} P50 type curve v3"])
with open(f"{RAW}/master/engineer_assignments.csv", "w", newline="") as f:
    cw = csv.writer(f); cw.writerow(["well_id", "engineer_id", "engineer_name", "assigned_since"])
    for w in wells: cw.writerow([w["well_id"], w["engineer_id"], w["engineer"], "2026-01-01"])

key = [dict(well_id=w["well_id"], engineer_id=w["engineer_id"], scenario=w["scenario"],
            scenario_name=SCN_INFO[w["scenario"]][0] if w["scenario"] else None,
            needs_attention=bool(w["scenario"] and SCN_INFO[w["scenario"]][1]),
            expected_flags=SCN_INFO[w["scenario"]][2] if w["scenario"] else []) for w in wells]
json.dump(key, open(f"{OUT}/answer_key/wells.json", "w"), indent=1)
print(f"wells {len(wells)} | scada rows {len(rows)} in {len(weeks)} weekly files | resends {resend_count} | sensor errors {sensor_errors} | downtime events {len(downtime)} | WOs {len(workorders)}")
print("needs attention:", sum(k['needs_attention'] for k in key), "| benign look-alikes:", sum(1 for k in key if k['scenario'] in ('S9', 'S10')))
