"""Deploy the Well Watch Databricks App with the Python SDK (no CLI needed).
Usage: python deploy.py [free|dakota]   (default: dakota)
  free   -> personal Free Edition workspace, schema workspace.well_ops
  dakota -> Dakota's Azure workspace, schema dataloader_v2_dogfood.well_watch
Each target's client() comes from dbx.py / dbx_dakota.py (OAuth session, not in this repo)."""
import importlib, io, os, sys
sys.path.insert(0, os.path.expanduser("~/"))
sys.path.insert(0, "/home/claude")
from dbx import sql
from databricks.sdk.service import apps as A
from databricks.sdk.service.workspace import ImportFormat

TARGETS = {
    "free": {"module": "dbx", "warehouse": "e7e26c8b767a5be9", "schema": "workspace.well_ops"},
    "dakota": {"module": "dbx_dakota", "warehouse": "b9c4909fd7b5f266", "schema": "dataloader_v2_dogfood.well_watch"},
}
TARGET = sys.argv[1] if len(sys.argv) > 1 else "dakota"
T = TARGETS[TARGET]
APP, EP, ALERT_EP = "well-watch", "databricks-gpt-oss-120b", "databricks-qwen3-next-80b-a3b-instruct"
WH, SCHEMA = T["warehouse"], T["schema"]
HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app")
w = importlib.import_module(T["module"]).client()
me = w.current_user.me().user_name
dest = f"/Workspace/Users/{me}/apps/{APP}"
print("target", TARGET, w.config.host, "as", me)

# 1. upload source; app.yaml gets this target's schema
# The built-in safety rules the server enforces are generated from the flag engine, so the two never drift.
import subprocess
subprocess.run(["node", "-e", "const F=require('./static/flags.js');require('fs').writeFileSync('locked_rules.json',JSON.stringify({note:'Built-in safety rules, generated from static/flags.js by deploy.py. The server puts these back on every rule save, so they cannot be turned off, weakened or deleted.',rules:F.DEFAULT_RULES.filter(F.isSafety)},null,1))"], cwd=HERE, check=True)
w.workspace.mkdirs(dest + "/static")
for rel in ["app.py", "agent.py", "alerts.py", "incidents.py", "issues.py", "locked_rules.json", "app.yaml", "requirements.txt", "static/index.html", "static/app.js", "static/flags.js"]:
    with open(os.path.join(HERE, rel), "rb") as f:
        data = f.read()
    if rel == "app.yaml":
        data = data.replace(b"value: workspace.well_ops", f"value: {SCHEMA}".encode())
    w.workspace.upload(f"{dest}/{rel}", io.BytesIO(data), format=ImportFormat.AUTO, overwrite=True)
print("uploaded to", dest)

# 2. create the app with its resources (warehouse + model endpoints), or update them
resources = [
    A.AppResource(name="sql-warehouse", sql_warehouse=A.AppResourceSqlWarehouse(id=WH, permission=A.AppResourceSqlWarehouseSqlWarehousePermission.CAN_USE)),
    A.AppResource(name="llm-endpoint", serving_endpoint=A.AppResourceServingEndpoint(name=EP, permission=A.AppResourceServingEndpointServingEndpointPermission.CAN_QUERY)),
    A.AppResource(name="alert-model", serving_endpoint=A.AppResourceServingEndpoint(name=ALERT_EP, permission=A.AppResourceServingEndpointServingEndpointPermission.CAN_QUERY)),
]
desc = "Well Watch: daily ranked well list for production engineers, safety tracking, a grounded data assistant and agent-drafted alerts. Synthetic data."
if APP not in {a.name for a in w.apps.list()}:
    w.apps.create_and_wait(app=A.App(name=APP, description=desc, resources=resources))
else:
    w.apps.update(name=APP, app=A.App(name=APP, description=desc, resources=resources))
app = w.apps.get(APP)
sp = app.service_principal_client_id
print("app", app.name, "sp", sp, "compute", app.compute_status.state if app.compute_status else None)

# 3. Unity Catalog grants for the app's service principal (read the medallion, write only the app_* tables engineers change; nothing on well_eval)
catalog = SCHEMA.split(".")[0]
for g in [f"GRANT USE CATALOG ON CATALOG {catalog} TO `{sp}`",
          f"GRANT USE SCHEMA, SELECT ON SCHEMA {SCHEMA} TO `{sp}`",
          f"GRANT READ VOLUME ON VOLUME {SCHEMA}.landing TO `{sp}`",
          *[f"GRANT MODIFY ON TABLE {SCHEMA}.{t} TO `{sp}`" for t in ("app_flag_rules", "app_flag_settings", "app_custom_fields", "app_well_attributes",
                                                                     "app_flag_acks", "app_fix_estimates", "app_well_notes", "app_alert_tasks",
                                                                     "app_safety_incidents", "app_incident_events", "app_incident_notifications", "app_corrective_actions",
                                                                     "app_production_issues", "app_issue_events", "app_morning_calls", "gold_reason_codes")]]:
    try:
        sql(w, g, WH)
    except RuntimeError as e:
        if "USE CATALOG" in g and "MANAGE" in str(e):
            print(f"PENDING: the catalog owner must run:  {g}")
        else:
            raise
print("grants done")

# 4. start compute if needed, then deploy
if app.compute_status and app.compute_status.state and app.compute_status.state.value not in ("ACTIVE", "STARTING"):
    w.apps.start_and_wait(APP)
dep = w.apps.deploy_and_wait(app_name=APP, app_deployment=A.AppDeployment(source_code_path=dest))
print("deployment", dep.status.state, dep.status.message)
print("URL", w.apps.get(APP).url)
