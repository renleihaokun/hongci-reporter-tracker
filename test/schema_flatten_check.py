import sqlite3, pathlib

sql = pathlib.Path(r"A:\app\workbuddyfiles\2026-09-20-18-43-30\hongci-report-tracker\schema.sql").read_text(encoding="utf-8")

# 模拟复制粘贴丢失换行：全部压成一行
flattened = " ".join(sql.split())
con = sqlite3.connect(":memory:")
con.executescript(flattened)
tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
cols = [r[1] for r in con.execute("PRAGMA table_info(lab_reports)")]
print("flattened OK, tables:", tables)
print("lab_reports cols:", cols)
assert tables == ["lab_reports", "us_reports", "meta"], tables
assert cols == ["id", "audit_time", "project", "reviewer", "items_json", "created_at"], cols
print("PASS")
