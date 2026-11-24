"""Run a .sql file of statements separated by blank-line + semicolon boundaries."""
import sys
sys.path.insert(0, "/home/claude")
from dbx import client, sql
w = client(); WH = "e7e26c8b767a5be9"
for path in sys.argv[1:]:
    for st in open(path).read().split(";\n\n"):
        st = st.strip().rstrip(";")
        if st and not all(l.strip().startswith("--") or not l.strip() for l in st.splitlines()):
            sql(w, st, WH, wait="50s")
    print("ran", path)
