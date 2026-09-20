-- D1 数据库结构（SQLite）
-- 用法: npx wrangler d1 execute hongci-reports --file=schema.sql

CREATE TABLE IF NOT EXISTS lab_reports (
  id          TEXT PRIMARY KEY,        -- 标本号，如 20260920LJA0024
  audit_time  TEXT NOT NULL,           -- 审核时间（原始格式 2026/9/20 8:52:48）
  project     TEXT NOT NULL,           -- 项目名称
  reviewer    TEXT,
  items_json  TEXT NOT NULL,           -- 明细 JSON 数组 [{name,result,flag,ref_lo,ref_hi,ref_text}]
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS us_reports (
  uid         TEXT PRIMARY KEY,        -- 内容哈希（源站无唯一ID）
  report_time TEXT NOT NULL,
  dept        TEXT,
  doctor      TEXT,
  findings    TEXT,                    -- 超声所见
  conclusion  TEXT,                    -- 超声结论
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- meta 里存放: patient_json（患者姓名/性别/年龄/床位/科室）, last_refresh
