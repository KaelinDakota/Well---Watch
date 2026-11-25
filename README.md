# Well Watch

A Databricks App for production engineers who look after hundreds of wells. Every morning it ranks each engineer's wells with flag rules the engineer controls, shows the top 10 to look at, and has a chat assistant that answers only from the data and links every number back to its source rows.

All data is synthetic: 200 wells, 4 engineers, 6 months of daily data.

The UI follows the Dakota Design System (dk tokens, Manrope/Inter/JetBrains Mono, Lucide icons) with light and dark themes. Fonts load from Google Fonts.

**New to the app, or to oil and gas?** Read the [user guide](docs/USER_GUIDE.md). It covers how to read each screen, what the colours mean, a glossary, and a five-minute demo script. This README is the technical overview.

## What's in here

| Path | What it is |
|---|---|
| `gen/make_safety.py` | Generates the safety feeds: the well safety register (MAASP, surface casing limits, MAOP, H2S, EPZ; East-area rows in kPa), daily safety readings (surface casing pressure, flowline pressure, H2S at surface, vented gas), test and inspection history, and the safety event log. It also writes `answer_key/safety.json`. |
| `gen/make_wells.py` | Generates the raw files: weekly SCADA exports (with late resends, -999 sensor errors and mixed gas units), downtime logs, work orders, monthly operating cost, the well master, type curves and engineer assignments. It also writes the answer key. |
| `pipeline/01_bronze.sql` | Bronze layer: raw files loaded as-is from the `landing` volume, with `_source_file`, `_loaded_at` and `_bronze_id` on every row. |
| `pipeline/02_silver.sql` | Silver layer: cleaned tables, plus `silver_cleaning_rules`. Silver deduplicates resends, converts E3M3 to MCF, nulls sensor errors, cleans well names and uses `ai_classify` to categorize downtime text. Each silver row records which rules touched it. |
| `pipeline/03_gold.sql` | Gold layer: `gold_daily_well` (with type-curve targets), `gold_downtime_events`, `gold_monthly_economics` and `gold_well_snapshot`, which holds one row per well with every field the flag rules use. |
| `pipeline/05_ranking.sql` | Tables for "being handled" acknowledgements (`app_flag_acks`), per-well fix cost estimates (`app_fix_estimates`), and ranking settings. |
| `pipeline/07_engineer_notes.sql` | Removes the app-written test and event tables, because those records come only from the source systems. Adds `app_well_notes`, an owner column on `app_flag_acks`, and `gold_source_freshness`. |
| `pipeline/06_glossary.sql` | `gold_glossary`: plain-language definitions the assistant cites for "what does X mean?" questions. |
| `pipeline/04_safety.sql` | Safety layer. Bronze, silver and gold safety tables; `ai_classify` sets event categories. Views merge system data with what engineers log in the app: `gold_v_compliance_items` (latest of each test type with its due date), `gold_v_safety_events` and `gold_v_well_safety`. Also creates the `app_*` tables the app writes to. |
| `app/app.py` | FastAPI backend. Endpoints: `/api/bundle`, `/api/well/{id}`, `PUT /api/rules/{engineer}`, `/api/lineage`, `/api/chat`, plus the endpoints engineers write through: `/api/notes` (and `/api/notes/{id}/archive`), `/api/acks`, `/api/estimates`, `/api/custom_fields` and `/api/attributes/{well}`. Tests and safety events are read-only. |
| `app/agent.py` | Our own chat agent (details below). |
| `app/static/` | The deployed UI: *My day*, *My wells*, *Safety*, *Flag rules*, the well page, the chat panel, and the evidence and lineage viewers. `flags.js` is the deterministic rule and ranking engine. |
| `web/` | Source copies of the three UI files. Edit these, then copy them to `app/static/` before deploying. |
| `docs/` | The [user guide](docs/USER_GUIDE.md) and its screenshots. |
| `deploy.py` | Deploys with the Databricks Python SDK. It uploads the source, sets up the app resources (SQL warehouse, model endpoint) and the Unity Catalog grants, then deploys. |
| `run_sql.py` | Runs the pipeline SQL files against a warehouse. |

## Safety

**What engineers can track.**
- **Integrity:** casing pressure against MAASP, surface casing pressure build-up and vent flow test results, failed packer or pressure tests, corrosion wall loss.
- **Sour gas:** H2S at surface, H2S alarms, detector calibration, and emergency response plan reviews for wells with residences in the EPZ.
- **Overpressure:** flowline pressure against MAOP, PSV lifts, repeated ESD trips.
- **Releases:** open spills, gas releases, fires and line failures, and reportable events not yet reported.
- **Environment:** venting against monthly limits, leak detection surveys, secondary containment inspections.
- **Lift equipment:** pumping-unit guard and brake inspections, ESP electrical faults.
- **Status and compliance:** inactive wells, overdue tests, open regulator non-compliances.

**Where records come from.** Production engineers don't record tests or incidents in this app.
- **Tests** come from the maintenance / integrity system (`compliance_tests.csv` → `silver_compliance_tests`).
- **Safety events** come from the HSE incident system (`safety_events.csv` → `silver_safety_events`).

Both are read-only here. What engineers add is context: **notes**. A note can report something the source system doesn't show yet (`pending_kind`/`pending_type`/`expected_by`). The UI confirms it when a matching record arrives, which drives `notes_count`, `pending_reports` and `unconfirmed_reports` on each well. The starter rule *Field report not confirmed* flags the overdue ones. The **data bar** under the tabs reads `gold_source_freshness` and turns a source amber when its last delivery is later than `stale_after_hours`.

**How rules work.**
- A rule can look at one of three things: **well readings and status**, **each test or inspection**, or **each safety event**. For tests and events, a well is flagged when at least N items match (for example, 3 or more unplanned ESD trips in 30 days).
- **Anything the feeds don't carry can still be tracked.** Engineers define their own per-well fields (number, text, yes/no, date), which become available in the rule editor.
- **Safety first** is on by default. Wells with a Critical or Warning safety flag rank above all other wells.

The app flags and informs. Decisions on shut-in, repair and reporting stay with qualified people, under company procedures and regulator requirements.

## How the ranking works

Rules are plain JSON: conditions, a severity, a weight in points, and optionally a **group** and a **typical fix cost**. No AI decides a flag. Ranking happens in tiers, in the way production engineers usually work through their list.

1. **Safety.** Wells with a Critical or Warning safety flag, most severe first. This tier is on by default; turn off "Safety first" to drop it.
2. **Production and cost.** Other Critical or Warning flags. The engineer chooses the sort order:
   - **$/day at risk** (default): oil lost against the type curve, plus the daily operating loss on wells that cost more to run than they earn.
   - **Fastest payback**: fix cost ÷ $/day. A fix cost comes from the rule's default or the engineer's own estimate for that well.
   - **Points.**
3. **Watch list.** Wells with only Review-level flags, ordered by points.
4. **Being handled.** Flags an engineer marked as being handled, with an owner, a follow-up date, and a note (required for safety flags). They leave the top 10 and come back on their own when:
   - the end date passes;
   - a condition moves more than 10% further past its threshold;
   - a new matching test or event appears.

   Optionally, wells with an open work order can count as being handled for production flags only. This is off by default.

Points still break ties. Rules in the same group, such as "casing pressure near MAASP" and "casing pressure rising", count once at the highest weight instead of adding up. The starter fix costs are rough placeholders; engineers should replace them with their own numbers.

Saved to: `app_flag_rules`, `app_flag_settings`, `app_flag_acks` and `app_fix_estimates` (created by `pipeline/05_ranking.sql`).

## Showing why a well is flagged

- **Well page.** A *Why this well is flagged* box at the top gives, for each open flag:
  - the measured value against the rule's threshold;
  - the recent days that crossed it, worked out from the daily data on the page;
  - links to the test or event records involved.

  It also lists which checks are within limits. Boxes and charts behind a flag get a red border and move first. Safety charts draw each enabled rule's threshold, and readings past it show as red dots.
- **Trace views.** `buildFocus()` in `app.js` maps each fired condition to the related columns in the gold, silver and bronze rows (the `RELATED` table). It then:
  - turns cells that cross the rule's threshold red, by reusing `FlagEngine.matchValue`;
  - shades the related columns;
  - moves highlighted columns next to well and date, and lists highlighted fields first in single-record views;
  - shows a *Look at these first* banner.
- **Tests.** The Status column (OK, due soon, overdue, failed) carries the colour. *Safety-critical* is a neutral label about how important the test is, not its result.

## How the assistant stays grounded

1. **Tools are the only source of facts.** The model is `databricks-gpt-oss-120b` on Databricks Model Serving. It can only learn facts by calling parameterized SQL tools on the gold tables (ranking, snapshot, production history, downtime, economics, work orders, search, portfolio summary).
2. **Every tool call is stored as evidence (E1, E2, …).** Each record holds the layer, table, exact SQL and rows. Production and downtime tools also return precomputed totals and averages, so the model can copy figures instead of doing arithmetic.
3. **The model must cite evidence IDs.** After it answers, `verify()` checks every statement:
   - every citation must exist;
   - any sentence with a number or a well ID must be cited;
   - every number in a cited sentence must appear in that evidence.

   Anything that fails is highlighted in the UI. The answer shows "All n factual statements verified" with a check, or a warning with "n of m verified".
4. **Every evidence row can be traced back to its source.** Rows trace back through silver and bronze to the raw landing file. Lineage shows which cleaning rules applied and, for resent days, which bronze version won.

### Every answer shows where its data came from

The assistant must look something up for every question:
- **What a term means:** the `gold_glossary` table (`pipeline/06_glossary.sql`).
- **How ranking works:** the engineer's saved rules.
- **Anything about wells:** the data tools.

If it answers without a lookup, the app sends it back to look first. If it still has none, the answer is marked "no source" in red.

Each answer ends with a **Sources** list that the app builds from the lookups it actually ran, not from the model's text. Each source links to its tables in Databricks Catalog Explorer, and "view rows and trace to raw file" opens the rows with lineage back to the landing file.

## Agent alerts (Greg and the checker)

`app/alerts.py`, `pipeline/08_alerts.sql`. When a critical flag needs someone told:
1. Recipients are data, not model output: `gold_alert_routing` (rule, group or category → roles, first role owns the task) joined to `gold_well_contacts` (synthetic directory by area, from `bronze_contact_directory` → `silver_contacts`).
2. Greg (`ALERT_DRAFT_MODEL`, default `databricks-qwen3-next-80b-a3b-instruct`) drafts email, Teams and SMS as JSON from the well's gold facts, the flag, its rule thresholds and related flags.
3. The checker runs deterministic checks (numbers in the facts, quoted limits are rule thresholds or MAASP/MAOP, well, severity, next step, due date, report link, only routed people, no claims of action, SMS length) and a model review on a different model (`ALERT_CHECK_MODEL`, default `databricks-gpt-oss-120b`, low reasoning effort). Any failure sends the drafts back to Greg once.
4. Each model call is capped at 20 s, with a retry on the other model.
5. Approval writes `app_alert_tasks` (owner, due date, approved messages, checks) and marks the flag and its related flags as being handled. Nothing is sent.

Endpoints: `POST /api/alerts/draft`, `POST /api/alerts/tasks`, `POST /api/alerts/tasks/{id}/status`, `POST /api/alerts/reset_demo`. The pressure-spike demo overlays a simulated reading in the browser only.

## Results (synthetic answer key)

- **Safety.** 22 planted safety problems across 16 types, plus 5 look-alikes: a planned ESD function test during a turnaround, a known low non-serious vent flow, and an old spill that was closed out and reported. All 22 fire their expected rules and land in their engineer's top 10. None of the look-alikes gets a safety flag. Results are in `workspace.well_eval.safety_scoring`.

- **Data.** The answer key has 23 planted problem wells across 8 failure types, plus 5 decoys (planned turnaround, recent workover).
- **Ranking.** The top 10 per engineer contains all 23 problem wells, and 0 decoys. All expected flags fired.
- **Where results live.** The scores are in `workspace.well_eval.top10_scoring`. The app's service principal has no grants on `well_eval`.

## Run it

1. Upload the files from `dataset/raw/` to `/Volumes/workspace/well_ops/landing/`.
2. Run `pipeline/01–07` in order (`python run_sql.py pipeline/01_bronze.sql`, …).
3. Run `python deploy.py`.

The app needs a serverless SQL warehouse and access to the `databricks-gpt-oss-120b` endpoint. You can change the endpoint in `deploy.py`.

## Working on this together

- **Edit the UI in `web/`.** `deploy.py` deploys from `app/static/`, so copy the files over first: `cp web/index.html web/app.js web/flags.js app/static/`.
- **`dbx.py` signs in with your own Databricks OAuth session** (stored in `~/.ridgeline/session_free.json`, which is never committed). Change `HOST` in it to point at a different workspace.
- **Answer key.** `dataset/answer_key/` and the `workspace.well_eval` schema hold the answer key for the synthetic data. The app must never read them.
- **Use branches and pull requests.** Work on a branch and open a pull request, so two people's changes don't overwrite each other.
