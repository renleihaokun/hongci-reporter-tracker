/**
 * 本地开发预览服务器（无需 Cloudflare 账号即可预览前端效果）
 * 用法:
 *   node test/dev-server.mjs                # 用内置虚构示例数据
 *   DATA_JSON=/path/to/data.json node test/dev-server.mjs   # 用真实归档数据（Python 版格式）
 * 然后打开 http://localhost:8788
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT || 8788;

function loadData() {
  const custom = process.env.DATA_JSON;
  if (custom && existsSync(custom)) {
    // 兼容 Python 版 data.json 结构
    const d = JSON.parse(readFileSync(custom, "utf8"));
    return {
      ok: true,
      patient: d.patient || {},
      last_refresh: new Date().toISOString(),
      lab_reports: Object.values(d.lab_reports || {}),
      us_reports: Object.values(d.us_reports || {}),
    };
  }
  return JSON.parse(readFileSync(join(ROOT, "test", "sample-data.json"), "utf8"));
}

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json" };

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/data") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(loadData()));
    return;
  }
  if (url.pathname === "/api/refresh") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, new_lab_count: 0, new_us_count: 0, new_labs: [], new_us: [], latest: {}, refreshed_at: new Date().toISOString() }));
    return;
  }
  const path = join(ROOT, "public", url.pathname === "/" ? "index.html" : url.pathname);
  if (!path.startsWith(join(ROOT, "public")) || !existsSync(path)) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "Content-Type": (MIME[extname(path)] || "application/octet-stream") + "; charset=utf-8" });
  res.end(readFileSync(path));
}).listen(PORT, () => console.log(`预览: http://localhost:${PORT}`));
