"""Deploy the Well Watch Databricks App with the Python SDK (no CLI needed).
Usage: python deploy.py   (expects dbx.client() to return an authenticated WorkspaceClient)"""
import io, os, sys
sys.path.insert(0, os.path.expanduser("~/"))
sys.path.insert(0, "/home/claude")
from dbx import client, sql
from databricks.sdk.service import apps as A
from databricks.sdk.service.workspace import ImportFormat

APP, WH, EP, SCHEMA = "well-watch", "e7e26c8b767a5be9", "databricks-gpt-oss-120b", "workspace.well_ops"
HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app")
w = client()
me = w.current_user.me().user_name
dest = f"/Workspace/Users/{me}/apps/{APP}"

# 1. upload source
w.workspace.mkdirs(dest + "/static")
for rel in ["app.py", "agent.py", "app.yaml", "requirements.txt", "static/index.html", "static/app.js", "static/flags.js"]:
    with open(os.path.join(HERE, rel), "rb") as f:
        w.workspace.upload(f"{dest}/{rel}", io.BytesIO(f.read()), format=ImportFormat.AUTO, overwrite=True)
print("uploaded to", dest)

# 2. create the app with its resources (warehouse + model endpoint), or update them
resources = [
    A.AppResource(name="sql-warehouse", sql_warehouse=A.AppResourceSqlWarehouse(id=WH, permission=A.AppResourceSqlWarehouseSqlWarehousePermission.CAN_USE)),
    A.AppResource(name="llm-endpoint", serving_endpoint=A.AppResourceServingEndpoint(name=EP, permission=A.AppResourceServingEndpointServingEndpointPermission.CAN_QUERY)),
]
existing = {a.name for a in w.apps.list()}
if APP not in existing:
    app = w.apps.create_and_wait(app=A.App(name=APP, description="Well Watch: daily ranked well list with safety-first flag rules, safety log and a grounded data assistant", resources=resources))
else:
    app = w.apps.update(name=APP, app=A.App(name=APP, description="Well Watch: daily ranked well list with safety-first flag rules, safety log and a grounded data assistant", resources=resources))
app = w.apps.get(APP)
sp = app.service_principal_client_id
print("app", app.name, "sp", sp, "compute", app.compute_status.state if app.compute_status else None)

# 3. Unity Catalog grants for the app's service principal (read the medallion, write only the app_* tables engineers change; nothing on well_eval)
for g in [f"GRANT USE CATALOG ON CATALOG workspace TO `{sp}`",
          f"GRANT USE SCHEMA, SELECT ON SCHEMA {SCHEMA} TO `{sp}`",
          *[f"GRANT MODIFY ON TABLE {SCHEMA}.{t} TO `{sp}`" for t in ("app_flag_rules", "app_flag_settings", "app_custom_fields", "app_well_attributes",
                                                                     "app_flag_acks", "app_fix_estimates", "app_well_notes")]]:
    sql(w, g, WH)
print("grants done")

# 4. start compute if needed, then deploy
if app.compute_status and app.compute_status.state and app.compute_status.state.value not in ("ACTIVE", "STARTING"):
    w.apps.start_and_wait(APP)
dep = w.apps.deploy_and_wait(app_name=APP, app_deployment=A.AppDeployment(source_code_path=dest))
print("deployment", dep.status.state, dep.status.message)
print("URL", w.apps.get(APP).url)
