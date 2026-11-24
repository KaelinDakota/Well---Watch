"""Shared Databricks client for the Ridgeline project (OAuth session with refresh token)."""
import json, os
from databricks.sdk import WorkspaceClient
from databricks.sdk.oauth import SessionCredentials

HOST = "https://dbc-340ac215-fd68.cloud.databricks.com"
_S = os.path.expanduser("~/.ridgeline/session_free.json")


def client() -> WorkspaceClient:
    creds = SessionCredentials.from_dict(json.load(open(_S)), token_endpoint=f"{HOST}/oidc/v1/token", client_id="databricks-cli")
    w = WorkspaceClient(host=HOST, credentials_strategy=creds)
    old = os.umask(0o077)
    try:
        json.dump(creds.as_dict(), open(_S, "w"))  # persist refreshed token
    finally:
        os.umask(old)
    return w


def sql(w, statement, warehouse_id, wait="50s"):
    from databricks.sdk.service.sql import StatementState
    r = w.statement_execution.execute_statement(statement=statement, warehouse_id=warehouse_id, wait_timeout=wait)
    while r.status.state in (StatementState.PENDING, StatementState.RUNNING):
        import time; time.sleep(3)
        r = w.statement_execution.get_statement(r.statement_id)
    if r.status.state != StatementState.SUCCEEDED:
        raise RuntimeError(f"{r.status.state}: {r.status.error.message if r.status.error else ''}\n{statement[:300]}")
    return r.result.data_array if r.result else None
