"""Synthetic SAFETY data for the Well Watch demo (same 200 wells, same 2026-05-27..2026-11-22 window, "today" = 2026-11-23).

Raw files written to dataset/raw/:
  master/well_safety_register.csv   per-well limits and hazards (some rows in kPa, as an East-area system exports them)
  safety/safety_readings_2026-MM.csv daily surface-casing pressure, flowline max pressure, ambient H2S, vented gas (-999 = sensor error)
  compliance/compliance_tests.csv     test and inspection history (results typed inconsistently: PASS, passed, Fail - leak...)
  safety/safety_events.csv            ESD trips, PSV lifts, alarms, spills, releases, regulator findings (free-text descriptions)
Answer key: dataset/answer_key/safety.json (planted safety scenarios and look-alike decoys)."""
import csv, json, os, random
from datetime import date, timedelta

random.seed(23)
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dataset")
RAW = os.path.join(ROOT, "raw")
START, END, TODAY = date(2026, 5, 27), date(2026, 11, 22), date(2026, 11, 23)
KPA = 6.894757

wells = list(csv.DictReader(open(os.path.join(RAW, "master", "well_master.csv"))))
snap = {r["well_id"]: r for r in json.load(open(os.path.join(ROOT, "..", "web", "data", "snapshot.json")))}
W = {w["well_id"]: w for w in wells}
days = [START + timedelta(d) for d in range((END - START).days + 1)]

# ---------------- planted scenarios ----------------
ESP_ENG4 = next(w for w in sorted(W) if "W-161" <= w <= "W-200" and W[w]["lift_type"] == "ESP" and w not in ("W-166", "W-173", "W-179", "W-185", "W-191", "W-196", "W-170", "W-162", "W-181", "W-188"))
SCN = {
    "W-038": ("SF1", "Production casing near MAASP", ["SAFE_CASING_NEAR_MAASP"]),
    "W-118": ("SF1", "Production casing near MAASP", ["SAFE_CASING_NEAR_MAASP"]),
    "W-031": ("SF1", "Production casing near MAASP (also rising)", ["SAFE_CASING_NEAR_MAASP", "CASING_PRESSURE_RISING"]),
    "W-064": ("SF2", "Surface casing pressure building (possible vent flow)", ["SAFE_SC_PRESSURE"]),
    "W-170": ("SF3", "Serious surface casing vent flow on latest test", ["SAFE_SCVF_SERIOUS", "SAFE_SC_PRESSURE"]),
    "W-047": ("SF4", "H2S detected at surface", ["SAFE_H2S_AMBIENT", "SAFE_H2S_ALARMS"]),
    "W-133": ("SF4", "H2S detected at surface", ["SAFE_H2S_AMBIENT", "SAFE_H2S_ALARMS"]),
    "W-088": ("SF5", "Flowline pressure near MAOP", ["SAFE_FLOWLINE_MAOP"]),
    "W-019": ("SF6", "Repeated unplanned ESD trips", ["SAFE_ESD_TRIPS"]),
    "W-181": ("SF6", "Repeated unplanned ESD trips", ["SAFE_ESD_TRIPS"]),
    "W-099": ("SF7", "Pressure safety valve lifted", ["SAFE_PSV_LIFT"]),
    "W-055": ("SF8", "Subsurface safety valve test overdue", ["SAFE_CRITICAL_TEST_OVERDUE"]),
    "W-125": ("SF8", "PSV recertification overdue", ["SAFE_CRITICAL_TEST_OVERDUE"]),
    "W-188": ("SF8", "H2S detector calibration overdue", ["SAFE_CRITICAL_TEST_OVERDUE"]),
    "W-140": ("SF9", "Failed packer isolation test, no retest", ["SAFE_FAILED_TEST"]),
    "W-027": ("SF10", "Spill not yet closed out", ["SAFE_SPILL_OPEN"]),
    "W-102": ("SF11", "Reportable spill not reported to regulator", ["SAFE_UNREPORTED", "SAFE_SPILL_OPEN"]),
    "W-162": ("SF12", "Open gas release", ["SAFE_GAS_RELEASE"]),
    "W-076": ("SF13", "Venting above monthly limit", ["SAFE_VENT_LIMIT"]),
    "W-112": ("SF14", "Corrosion survey shows high wall loss", ["SAFE_WALL_LOSS"]),
    "W-146": ("SF15", "Open regulator non-compliance", ["SAFE_NONCOMPLIANCE"]),
    ESP_ENG4: ("SF16", "ESP electrical fault", ["SAFE_ELECTRICAL"]),
}
DECOYS = {
    "W-012": "Planned ESD trips during Kestrel turnaround", "W-013": "Planned ESD trips during Kestrel turnaround", "W-014": "Planned ESD trips during Kestrel turnaround",
    "W-150": "Known non-serious vent flow, low stable surface casing pressure, tests current",
    "W-120": "Old spill, closed out and reported",
}
SOUR_FORCE = {"W-047", "W-133", "W-188"}

# ---------------- safety register ----------------
reg, unit_kpa = {}, {w for w in W if W[w]["area"] == "East"}
for wid, w in W.items():
    csg = float(snap[wid]["casing_psi_7d"] or 200)
    sour_p = {"Montney": .45, "Duvernay": .35, "Cardium": .1, "Viking": .05}[w["reservoir"]]
    sour = wid in SOUR_FORCE or (random.random() < sour_p and wid not in DECOYS and wid not in SCN)
    h2s = random.choice([3500, 6000, 9000, 14000, 22000]) if sour else random.choice([0, 0, 5, 10, 40])
    maasp = csg / (0.87 if wid in ("W-038", "W-118") else random.uniform(0.25, 0.5))
    if wid == "W-031": maasp = 650
    sclimit = random.choice([250, 300, 350])
    reg[wid] = dict(well_id=wid, licence_status="Active", sour_class=("Critical sour" if h2s >= 10000 and random.random() < .3 else "Sour") if sour else "Sweet",
        h2s_ppm_gas=h2s, epz_m=(random.choice([500, 800, 1200, 2000]) if sour else 0), residences_in_epz=(random.choice([0, 0, 1, 3, 6]) if sour else 0),
        has_sssv=("Y" if (wid == "W-055" or random.random() < .2) else "N"),
        prod_casing_maasp=round(maasp / 5) * 5, surface_casing_limit=sclimit, wellhead_rating=random.choice([2000, 3000, 5000]),
        flowline_maop=random.choice([600, 720, 900, 1440]), flowline_material=random.choice(["Steel", "Steel", "Composite", "HDPE"]),
        vent_limit_m3_month=random.choice([300, 500, 900]), corrosion_risk=random.choice(["Low", "Low", "Medium", "High"]),
        sand_prone=random.choice(["N", "N", "N", "Y"]), pressure_unit="psi")
    if wid == "W-076": reg[wid]["vent_limit_m3_month"] = 300
    if wid in unit_kpa:  # East-area system exports pressures in kPa
        for k in ("prod_casing_maasp", "surface_casing_limit", "wellhead_rating", "flowline_maop"):
            reg[wid][k] = round(reg[wid][k] * KPA)
        reg[wid]["pressure_unit"] = "kPa"
os.makedirs(os.path.join(RAW, "master"), exist_ok=True)
with open(os.path.join(RAW, "master", "well_safety_register.csv"), "w", newline="") as f:
    c = csv.DictWriter(f, fieldnames=list(next(iter(reg.values())).keys())); c.writeheader(); c.writerows(reg.values())
psi = lambda wid, k: reg[wid][k] / KPA if reg[wid]["pressure_unit"] == "kPa" else reg[wid][k]

# ---------------- daily safety readings ----------------
os.makedirs(os.path.join(RAW, "safety"), exist_ok=True)
by_month = {}
for wid in W:
    sour = reg[wid]["sour_class"] != "Sweet"; maop = psi(wid, "flowline_maop"); fl_base = maop * random.uniform(.35, .6)
    sc_base = 6 if wid == "W-150" else (90 if wid == "W-170" else 0)
    vent_day = reg[wid]["vent_limit_m3_month"] / 30 * random.uniform(.1, .4)
    for d in days:
        t_end = (END - d).days
        sc = sc_base + random.uniform(0, 2) if sc_base else random.choice([0, 0, 0, 0, 1, 2])
        if wid == "W-064" and t_end <= 21: sc = 4 + (21 - t_end) * 8.5 + random.uniform(-3, 3)
        if wid == "W-170": sc = 90 + max(0, 30 - t_end) * 1.7 + random.uniform(-2, 2)
        fl = fl_base * random.uniform(.9, 1.15)
        if wid == "W-088" and t_end <= 10: fl = maop * (0.84 + (10 - t_end) * 0.012) + random.uniform(-4, 4)
        h2s = (random.choice([0, 0, 0, 1, 2, 3]) if sour else 0)
        if wid in ("W-047", "W-133") and t_end <= 5: h2s = random.choice([12, 15, 18, 25])
        vent = vent_day * random.uniform(.6, 1.4)
        if wid == "W-076" and d.month == 11: vent = 22 + random.uniform(-3, 4)
        row = dict(well_id=wid, reading_date=d.isoformat(), sc_psi=round(sc, 1), flowline_psi_max=round(fl, 1), h2s_ambient_ppm_max=h2s, vent_gas_m3=round(vent, 1))
        if random.random() < .003: row[random.choice(["sc_psi", "flowline_psi_max", "h2s_ambient_ppm_max"])] = -999
        by_month.setdefault(d.strftime("%Y-%m"), []).append(row)
for m, rows in by_month.items():
    with open(os.path.join(RAW, "safety", f"safety_readings_{m}.csv"), "w", newline="") as f:
        c = csv.DictWriter(f, fieldnames=list(rows[0].keys())); c.writeheader(); c.writerows(rows)

# ---------------- compliance tests ----------------
TESTS = [  # type, group, interval months, safety critical, applies(wid)
    ("Surface casing vent flow test", "Integrity", 12, True, lambda w: True),
    ("Packer isolation test", "Integrity", 24, True, lambda w: True),
    ("Corrosion (UT) survey", "Integrity", 24, False, lambda w: True),
    ("Wellhead master valve test", "Pressure safety", 12, True, lambda w: True),
    ("Subsurface safety valve test", "Pressure safety", 6, True, lambda w: reg[w]["has_sssv"] == "Y"),
    ("PSV recertification", "Pressure safety", 36, True, lambda w: True),
    ("ESD function test", "Pressure safety", 12, True, lambda w: True),
    ("Flowline pressure test", "Pressure safety", 60, True, lambda w: True),
    ("H2S detector calibration", "Detection", 6, True, lambda w: reg[w]["sour_class"] != "Sweet"),
    ("H2S emergency response plan review", "Emergency response", 12, True, lambda w: reg[w]["sour_class"] != "Sweet" and reg[w]["residences_in_epz"] > 0),
    ("Pumping unit guard and brake inspection", "Lift equipment", 12, True, lambda w: W[w]["lift_type"] == "Rod pump"),
    ("ESP insulation resistance test", "Lift equipment", 6, False, lambda w: W[w]["lift_type"] == "ESP"),
    ("LDAR fugitive emissions survey", "Environment", 12, False, lambda w: True),
    ("Secondary containment inspection", "Environment", 12, False, lambda w: True),
]
PASS = ["Pass", "PASS", "passed", "Pass ", "OK - pass"]
add_m = lambda d, m: date(d.year + (d.month - 1 + m) // 12, (d.month - 1 + m) % 12 + 1, min(d.day, 28))
tests, tid = [], 0
def T(wid, ttype, d, result, value=None, unit="", note=""):
    global tid; tid += 1
    tests.append(dict(test_id=f"T{tid:05d}", well_id=wid, test_type=ttype, test_date=d.isoformat(), result=result, result_value=value if value is not None else "",
                      result_unit=unit, performed_by=random.choice(["Field ops", "Integrity contractor", "Prairie Testing Ltd", "Wellsite supervisor"]), notes=note))
for wid in W:
    for ttype, grp, months, crit, ok in TESTS:
        if not ok(wid): continue
        # next due spread over the interval; ~1% due within 30 days
        due_in = random.randint(5, 29) if random.random() < .01 else random.randint(35, max(36, months * 30 - 5))
        last = TODAY + timedelta(due_in) - timedelta(days=round(months * 30.4))
        overrides = {("W-055", "Subsurface safety valve test"): -45, ("W-125", "PSV recertification"): -20, ("W-188", "H2S detector calibration"): -32}
        if (wid, ttype) in overrides: last = TODAY + timedelta(overrides[(wid, ttype)]) - timedelta(days=round(months * 30.4))
        prev = last - timedelta(days=round(months * 30.4))
        val = unit = ""
        if ttype == "Corrosion (UT) survey": val, unit = round(random.uniform(3, 22), 1), "% wall loss"
        if ttype == "Surface casing vent flow test": val, unit = 0, "m3/d"
        T(wid, ttype, prev, random.choice(PASS), val if val != "" else None, unit)
        res, note = random.choice(PASS), ""
        if wid == "W-112" and ttype == "Corrosion (UT) survey": val, note = 46.0, "Heavy internal pitting at 6 o'clock, flowline riser"
        if wid == "W-150" and ttype == "Surface casing vent flow test": res, val, note = "Non-serious", 12, "Registered non-serious SCVF, monitor annually"
        if wid == "W-170" and ttype == "Surface casing vent flow test":
            last, res, val, note = date(2026, 11, 5), "SERIOUS - flow 410 m3/d", 410, "Serious SCVF; repair required per regulator timeline"
        if wid == "W-064" and ttype == "Surface casing vent flow test": val = 0
        T(wid, ttype, last, res, val if val != "" else None, unit, note)
        if wid == "W-140" and ttype == "Packer isolation test":
            T(wid, ttype, date(2026, 10, 30), "Fail - pressure communication tbg/csg", 0, "", "Annulus pressured up during test; retest after workover")
os.makedirs(os.path.join(RAW, "compliance"), exist_ok=True)
with open(os.path.join(RAW, "compliance", "compliance_tests.csv"), "w", newline="") as f:
    c = csv.DictWriter(f, fieldnames=list(tests[0].keys())); c.writeheader(); c.writerows(tests)

# ---------------- safety events ----------------
ev, eid = [], 0
def E(wid, d, typ, desc, planned="N", vol="", sub="", reportable="N", reported="N", status="Closed", hour=None):
    global eid; eid += 1
    ev.append(dict(event_id=f"SE{eid:05d}", well_id=wid, event_ts=f"{d.isoformat()} {hour if hour is not None else random.randint(0, 23):02d}:{random.randint(0, 59):02d}",
                   event_type=typ, description=desc, planned=planned, volume_m3=vol, substance=sub, reportable=reportable, reported_to_regulator=reported, status=status))
rnd_day = lambda lo, hi: START + timedelta(random.randint(lo, hi))
exclude = set(SCN) | set(DECOYS)
for wid in W:  # background: occasional single trips, nuisance alarms and near misses, all closed
    if wid in exclude: continue
    if random.random() < .25: E(wid, rnd_day(0, 150), random.choice(["ESD trip", "esd shutdown", "ESD"]), random.choice(["High pressure shutdown, reset by operator", "Lost power to ESD panel, reset", "Flowline high-pressure switch trip, cleared"]))
    if random.random() < .08: E(wid, rnd_day(0, 170), "Near miss", random.choice(["Dropped tool from wellhead platform, no injury", "Vehicle backing near wellhead, stopped by spotter"]))
    if reg[wid]["sour_class"] != "Sweet" and random.random() < .1: E(wid, rnd_day(0, 140), "H2S alarm", "Single 10 ppm alarm during maintenance, cleared in 5 min")
for d, h in [(date(2026, 10, 27), 3), (date(2026, 11, 4), 14), (date(2026, 11, 11), 22), (date(2026, 11, 19), 6)]:
    E("W-019", d, random.choice(["ESD trip", "esd shutdown"]), "High pressure shutdown on separator, reset by operator", hour=h)
for d in [date(2026, 11, 2), date(2026, 11, 13), date(2026, 11, 21)]:
    E("W-181", d, "ESD", "Unexplained ESD, no alarm before trip, restarted", hour=random.randint(0, 23))
for wid in ("W-012", "W-013", "W-014"):
    for d in [date(2026, 11, 10), date(2026, 11, 12)]: E(wid, d, "ESD trip", "Planned ESD function test during Kestrel battery turnaround", planned="Y")
E("W-099", date(2026, 11, 18), "PSV lifted", "Separator PSV lifted at set pressure, gas to flare stack, downstream valve found closed", status="Open")
E("W-027", date(2026, 11, 14), "Spill", "Produced water spill at wellhead, cleanup in progress", vol=3.2, sub="Produced water", reportable="Y", reported="Y", status="Open")
E("W-102", date(2026, 11, 19), "spill", "Emulsion released from flowline drain, approx 2.5 m3 on lease", vol=2.5, sub="Emulsion", reportable="Y", reported="N", status="Open")
E("W-120", date(2026, 7, 9), "Spill", "Small produced water release, cleaned up and closed", vol=0.8, sub="Produced water", reportable="Y", reported="Y", status="Closed")
E("W-162", date(2026, 11, 20), "Gas release", "Gas leak at wellhead flange, area isolated, awaiting repair crew", sub="Natural gas", reportable="Y", reported="Y", status="Open")
E("W-146", date(2026, 10, 28), "Regulator non-compliance", "Field inspection: H2S signage missing and SCVF test record late. Corrective action due 2026-11-27.", status="Open")
E(ESP_ENG4, date(2026, 11, 17), "Electrical fault", "ESP ground fault alarm, drive tripped, phase imbalance on restart", status="Open")
for wid in ("W-047", "W-133"):
    for d in [date(2026, 11, 18), date(2026, 11, 20), date(2026, 11, 21)]: E(wid, d, "H2S alarm", "Fixed H2S monitor alarm at wellhead, levels above 10 ppm", status="Open")
ev.sort(key=lambda r: r["event_ts"])
with open(os.path.join(RAW, "safety", "safety_events.csv"), "w", newline="") as f:
    c = csv.DictWriter(f, fieldnames=list(ev[0].keys())); c.writeheader(); c.writerows(ev)

# ---------------- answer key ----------------
key = [dict(well_id=w, safety_scenario=s[0], scenario_name=s[1], expected_rules=s[2], decoy=False) for w, s in SCN.items()] + \
      [dict(well_id=w, safety_scenario=None, scenario_name=n, expected_rules=[], decoy=True) for w, n in DECOYS.items()]
json.dump(sorted(key, key=lambda k: k["well_id"]), open(os.path.join(ROOT, "answer_key", "safety.json"), "w"), indent=1)
print("register", len(reg), "readings", sum(len(v) for v in by_month.values()), "tests", len(tests), "events", len(ev), "ESP fault well", ESP_ENG4)
