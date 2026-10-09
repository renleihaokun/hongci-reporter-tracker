/**
 * /api/refresh 端到端测试：内存 D1 桩件 + 桩 fetch，直接跑真实的 onRequestPost。
 * 覆盖：增量归档、无明细归档、结构变化预警、limit 分批，
 * 以及"医院网络抖动自动重试"（详情先失败一次，重试后仍能入库）、
 * "明细持续失败的那份不入库、下一轮仍是 pending 会被重抓"（前端轮级自动重试依赖这条契约）。
 *
 * 桩 fetch 返回的字节取自 test/fixtures/*.gbk.html：医院站是 GBK，
 * 用真实 GBK 字节快照才能顺带验证 scraper 的 gb18030 解码路径
 * （由同目录 UTF-8 版 *.html 转码而来，转码脚本见 README「本地开发」）。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

/* Node 的 WebCrypto 不支持 MD5（workerd 支持），而 scraper 用 MD5 算超声 uid → 打个补丁 */
{
  const orig = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  const subtle = Object.create(globalThis.crypto.subtle);
  subtle.digest = (alg, data) => {
    if (String(alg).toUpperCase() === "MD5") {
      const h = createHash("md5").update(Buffer.from(data)).digest();
      return Promise.resolve(h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength));
    }
    return orig(alg, data);
  };
  Object.defineProperty(globalThis, "crypto", {
    value: new Proxy(globalThis.crypto, { get: (t, k) => (k === "subtle" ? subtle : t[k]) }),
    configurable: true,
  });
}

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const GBK = {
  list: readFileSync(join(FIX, "lab-list.gbk.html")),
  detail: readFileSync(join(FIX, "lab-detail.gbk.html")),
  nodetail: readFileSync(join(FIX, "lab-detail-nodetail.gbk.html")),
  us: readFileSync(join(FIX, "us-list.gbk.html")),
};
const ID1 = "20260920SHA0030";
const ID2 = "20260920LJA0024";

let fail = 0;
const eq = (a, b, msg) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  if (!good) { fail++; console.log("FAIL:", msg, "\n  got:", JSON.stringify(a), "\n  exp:", JSON.stringify(b)); }
  else console.log("ok:", msg);
};

/* ---------- 内存 D1 桩件：只覆盖 refresh.js 用到的语句 ---------- */
const tables = { lab_reports: new Map(), us_reports: new Map(), meta: new Map() };
let dbError = null; // 用例注入：模拟 D1/语句层故障（确定性失败）

function prepare(sql) {
  return {
    sql, args: [],
    bind(...a) { this.args = a; return this; },
    async all() {
      if (dbError) throw new Error(dbError);
      const s = sql.trim();
      if (/^SELECT id FROM lab_reports WHERE items_json = '\[\]'/i.test(s)) {
        const lim = parseInt((/LIMIT (\d+)/i.exec(s) || [])[1] || "999", 10);
        const rows = [...tables.lab_reports.values()]
          .filter((r) => r.items_json === "[]")
          .sort((a, b) => new Date(b.audit_time) - new Date(a.audit_time));
        return { results: rows.slice(0, lim).map((r) => ({ id: r.id })) };
      }
      if (/^SELECT id FROM lab_reports/i.test(s)) return { results: [...tables.lab_reports.values()].map((r) => ({ id: r.id })) };
      if (/^SELECT uid FROM us_reports/i.test(s)) return { results: [...tables.us_reports.values()].map((r) => ({ uid: r.uid })) };
      if (/^SELECT audit_time, project, items_json FROM lab_reports/i.test(s)) {
        return { results: [...tables.lab_reports.values()].map((r) => ({ audit_time: r.audit_time, project: r.project, items_json: r.items_json })) };
      }
      return { results: [] };
    },
    async run() {
      if (dbError) throw new Error(dbError);
      const s = sql.trim();
      if (/^INSERT OR IGNORE INTO lab_reports/i.test(s)) {
        const [id, audit_time, project, reviewer, items_json] = this.args;
        if (!tables.lab_reports.has(id)) tables.lab_reports.set(id, { id, audit_time, project, reviewer, items_json });
      } else if (/^INSERT OR IGNORE INTO us_reports/i.test(s)) {
        const [uid, report_time, dept, doctor, findings, conclusion] = this.args;
        if (!tables.us_reports.has(uid)) tables.us_reports.set(uid, { uid, report_time, dept, doctor, findings, conclusion });
      } else if (/^UPDATE lab_reports SET items_json = \? WHERE id = \?/i.test(s)) {
        const [items_json, id] = this.args;
        const row = tables.lab_reports.get(id);
        if (row) row.items_json = items_json;
      } else if (/^INSERT INTO meta/i.test(s)) {
        const key = (/VALUES \('([^']+)'/i.exec(s) || [])[1];
        tables.meta.set(key, this.args[0]);
      }
      return { success: true };
    },
  };
}
const DB = { prepare, async batch(stmts) { for (const s of stmts) await s.run(); return []; } };

const resetDb = () => { for (const t of Object.values(tables)) t.clear(); };
const labRows = () => [...tables.lab_reports.values()];

/* ---------- fetch 桩：按 URL 发 GBK 字节快照，可按需注入失败 ---------- */
const asciiPage = (html) => Buffer.from(html, "ascii"); // 纯 ASCII，GBK/UTF-8 编码一致
const paths = [];

function stubFetch(cfg = {}) {
  const fails = { list: cfg.listFails || 0, us: cfg.usFails || 0, ...(cfg.detailFails || {}) };
  const res = (status, buf) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    arrayBuffer: async () => buf,
  });
  return async (url) => {
    const u = String(url);
    paths.push(u);
    if (u.includes("Jianyanlist.asp")) {
      if (fails.list > 0) { fails.list--; throw new TypeError("fetch failed"); }
      if (cfg.listStatus) return res(cfg.listStatus, null);
      return res(200, cfg.listBody || GBK.list);
    }
    if (u.includes("Bbaogaolist_zy.asp")) {
      if (fails.us > 0) { fails.us--; throw new TypeError("fetch failed"); }
      return res(200, GBK.us);
    }
    const id = (/bh\.asp\?id=([^&]+)/.exec(u) || [])[1] || "?";
    if (fails[id] > 0) { fails[id]--; throw new TypeError("fetch failed"); }
    if (cfg.detailStatus && cfg.detailStatus[id]) return res(cfg.detailStatus[id], null);
    return res(200, cfg.detailBody ? cfg.detailBody(id) : GBK.detail);
  };
}

/** 跑一轮 /api/refresh，返回 { status, json, paths（本次请求发出的抓取 URL） } */
async function run(cfg = {}, limit) {
  globalThis.fetch = stubFetch(cfg.fetch || {});
  const before = paths.length;
  const url = "https://x/api/refresh" + (limit ? `?limit=${limit}` : "");
  const resp = await onRequestPost({
    env: { DB, PATIENT_PID: "000000", ...(cfg.env || {}) },
    request: new Request(url, { method: "POST" }),
  });
  return { status: resp.status, json: await resp.json(), paths: paths.slice(before) };
}

const realWarn = console.warn;
const realError = console.error;
console.warn = () => {}; // 重试日志在测试输出里是噪音
console.error = () => {}; // 同上（"详情抓取失败"是预期用例）
const { onRequestPost } = await import("../functions/api/refresh.js");

try {
  /* ---------- 1) 首轮：增量归档 + 关键指标 + 超声 ---------- */
  resetDb();
  {
    const { status, json: j, paths: p } = await run();
    eq(status, 200, "首轮 HTTP 200");
    eq([j.ok, j.new_lab_count, j.new_us_count], [true, 2, 1], "首轮归档 2 份检验 + 1 份超声");
    eq(j.failed_details, [], "首轮无失败");
    eq([j.no_detail_labs, j.has_more, j.timed_out_midway], [[], false, false], "无明细/无未完/无超时");
    eq(p.length, 4, "首轮抓取次数 = 2 个列表 + 2 份明细");
    eq(labRows().length, 2, "D1 里有 2 行检验报告");
    eq(tables.us_reports.size, 1, "D1 里有 1 行超声报告");
    eq(tables.meta.get("patient_json") !== undefined, true, "患者信息已写入 meta");
    eq(
      [j.latest["白细胞 (WBC)"].value, j.latest["白细胞 (WBC)"].flag, j.latest["白细胞 (WBC)"].date.trim()],
      [1.26, "↓", "2026/9/20"],
      "关键指标取血常规报告的白细胞"
    );
    eq(j.new_labs[0].abnormal.length, 4, "新增报告带异常项摘要");
  }

  /* ---------- 2) 第二轮：增量去重，不重复抓明细 ---------- */
  {
    const { json: j, paths: p } = await run();
    eq([j.new_lab_count, j.new_us_count, j.failed_details.length], [0, 0, 0], "第二轮无新增、无失败");
    eq(p.length, 2, "第二轮只抓 2 个列表（明细已归档，不重复抓）");
    eq(p.filter((u) => u.includes("bh.asp")).length, 0, "第二轮没有明细请求");
  }

  /* ---------- 3) 医院网络抖动：详情第一次失败，重试后仍入库 ---------- */
  resetDb();
  {
    const { json: j, paths: p } = await run({ fetch: { detailFails: { [ID1]: 1 } } });
    eq([j.ok, j.new_lab_count, j.failed_details.length], [true, 2, 0], "详情抖动一次 → 自动重试后 2 份全部入库");
    eq(p.filter((u) => u.includes(ID1)).length, 2, "失败那份确实重试了一次（请求 2 次）");
    eq(labRows().length, 2, "两份明细都写进了 D1");
  }

  /* ---------- 4) 列表页 5xx：重试到用尽，整轮回 503 + retryable 交给客户端再试 ---------- */
  resetDb();
  {
    const { status, json: j, paths: p } = await run({ fetch: { listStatus: 503 } });
    eq([status, j.ok, j.retryable], [503, false, true], "列表页持续 503 → 503 + retryable:true（客户端值得再试一轮）");
    eq(p.length, 3, "列表请求按 3 次尝试后放弃（指数退避重试）");
    eq(p.filter((u) => u.includes("Bbaogaolist")).length, 0, "列表都拿不到就不再去抓超声列表");
    eq(labRows().length, 0, "失败时不留半个归档");
  }

  /* ---------- 4b) D1/代码类故障：确定性失败，标 retryable:false 并原样透出原因 ---------- */
  resetDb();
  {
    dbError = "D1_ERROR: no such table: us_reports";
    let r;
    try { r = await run(); } finally { dbError = null; }
    eq([r.status, r.json.ok, r.json.retryable], [500, false, false], "D1 故障 → 500 + retryable:false（不再白等 4 轮重试）");
    eq(r.json.error.includes("no such table"), true, "错误原因原样透出（前端显示真实原因而不是 HTTP 500）");
  }

  /* ---------- 5) 详情持续 5xx：只影响那一份，其余照常入库 ---------- */
  resetDb();
  {
    const { json: j, paths: p } = await run({ fetch: { detailStatus: { [ID1]: 503 } } });
    eq([j.ok, j.new_lab_count], [true, 1], "一份详情持续失败不影响另一份入库");
    eq(j.failed_details.map((f) => f.id), [ID1], "失败的那份进 failed_details（前端据此自动回头重试）");
    eq(p.filter((u) => u.includes(ID1)).length, 3, "失败那份尝试了 3 次");
    eq(labRows().map((r) => r.id), [ID2], "D1 里只有成功的那份");
  }
  {
    // 客户端轮级重试（app.js 里 has_more 为 false 但 failed_details 非空时自动再发一轮）依赖的契约：
    // 失败的报告故意不入库，所以它下一轮仍是 pending，会被重新抓到 → 网络恢复后自动补齐，不需要人工干预
    const { json: j } = await run();
    eq([j.new_lab_count, j.failed_details.length], [1, 0], "上一轮失败的报告仍是 pending，下一轮重抓后入库");
    eq(labRows().map((r) => r.id).sort(), [ID1, ID2].sort(), "重抓后两份明细都在 D1 里（不重复、不丢）");
  }

  /* ---------- 6) 医院"不提供明细"占位页：归档但不反复重试 ---------- */
  resetDb();
  {
    const { json: j } = await run({ fetch: { detailBody: () => GBK.nodetail } });
    eq([j.new_lab_count, j.no_detail_labs.length, j.failed_details.length], [0, 2, 0], "占位页归档为无明细，不算失败");
    eq(labRows().every((r) => r.items_json === "[]"), true, "无明细以空明细入库");
  }
  {
    // 医院日后补齐 → 复查逻辑就地更新（复查限额已随重试一起收紧到 2）
    const { json: j } = await run();
    eq([j.republished.length, j.new_lab_count], [2, 0], "复查发现医院补明细 → 就地更新 2 份");
    eq(labRows().every((r) => r.items_json !== "[]"), true, "明细已补进归档");
  }

  /* ---------- 7) limit 分批：一次抓不完就 has_more，下一轮续上 ---------- */
  resetDb();
  {
    const a = await run({}, 1);
    eq([a.json.new_lab_count, a.json.has_more, a.json.pending_count], [1, true, 2], "limit=1 → 抓 1 份并提示还有");
    const b = await run({}, 1);
    eq([b.json.new_lab_count, b.json.has_more], [1, false], "第二轮 limit=1 → 抓完剩下的 1 份");
  }

  /* ---------- 8) 结构变化预警：页面含链接但解析为 0 → 502，前端不再重试 ---------- */
  resetDb();
  {
    const { status, json: j, paths: p } = await run({ fetch: { listBody: asciiPage('<a href="bh.asp?id=X">详情</a>') } });
    eq([status, j.ok], [502, false], "结构可疑 → HTTP 502");
    eq(j.error.includes("结构"), true, "错误信息提示页面结构变化");
    eq(labRows().length, 0, "结构可疑时不写库");
    eq(p.filter((u) => u.includes("bh.asp")).length, 0, "结构可疑时不再逐份抓明细");
  }

  /* ---------- 9) 未配置住院号：明确报错 ---------- */
  {
    const { status, json: j } = await run({ env: { PATIENT_PID: "" } });
    eq([status, j.ok, j.error.includes("PATIENT_PID")], [500, false, true], "缺 PATIENT_PID 时有明确报错");
  }
} finally {
  console.warn = realWarn;
  console.error = realError;
}

console.log(fail === 0 ? "\n/api/refresh 端到端测试全部通过 ✔" : `\n${fail} 项失败 ✘`);
process.exit(fail === 0 ? 0 : 1);
