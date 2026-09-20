/** POST /api/refresh — 抓取医院最新报告，增量写入 D1，返回变化简报 */
import { scrapeAll, scrapeLabDetail, DEFAULT_BASE } from "../_lib/scraper.js";

const KEY_ITEMS = [
  ["白细胞 (WBC)", (n) => n === "白细胞"],
  ["血红蛋白 (Hb)", (n) => n === "血红蛋白"],
  ["血小板 (PLT)", (n) => n === "血小板计数"],
  ["中性粒细胞 (ANC)", (n) => n === "中性粒细胞数"],
  ["C-反应蛋白 (CRP)", (n) => n.includes("C-反应蛋白") || n.toUpperCase() === "CRP"],
];

function parseDt(s) {
  const m = /(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(s || "");
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
}

export async function onRequestPost(context) {
  const { env } = context;
  const pid = env.PATIENT_PID;
  if (!pid) {
    return Response.json({ ok: false, error: "未配置环境变量 PATIENT_PID（住院号）" }, { status: 500 });
  }
  const base = env.HOSPITAL_BASE || DEFAULT_BASE;
  // 免费版单次请求子请求上限 50，预留余量，单次最多抓 40 份新详情（剩余的下轮继续）
  const MAX_DETAILS_PER_RUN = 40;
  // ?limit=N：客户端分批抓取（小批量多轮，便于前端展示实时进度），默认 40
  let limit = MAX_DETAILS_PER_RUN;
  try {
    const q = parseInt(new URL(context.request.url).searchParams.get("limit") || "", 10);
    if (Number.isFinite(q)) limit = Math.min(Math.max(q, 1), MAX_DETAILS_PER_RUN);
  } catch {}

  try {
    const { labList, usList, structureSuspect } = await scrapeAll(base, pid);
    if (structureSuspect) {
      return Response.json({
        ok: false,
        error: "医院页面结构可能已变化：页面含报告链接但解析结果为 0，请检查 functions/_lib/scraper.js 的解析规则",
      }, { status: 502 });
    }

    // 已归档的 ID
    const existing = new Set();
    const rows = await env.DB.prepare("SELECT id FROM lab_reports").all();
    for (const r of rows.results || []) existing.add(r.id);
    const existingUs = new Set();
    const rowsUs = await env.DB.prepare("SELECT uid FROM us_reports").all();
    for (const r of rowsUs.results || []) existingUs.add(r.uid);

    // 增量抓取检验详情（新的在前，先抓最新的；超限部分下轮继续）
    const pending = labList.filter((e) => !existing.has(e.id));
    const batch = pending.slice(0, limit);
    const hasMore = pending.length > batch.length;
    const newLabs = [];
    const failedDetails = [];
    for (const entry of batch) {
      let items = [];
      let okFetch = false;
      try {
        items = await scrapeLabDetail(base, entry.id);
        okFetch = true;
      } catch (e) {
        console.error("detail fetch failed", entry.id, e);
      }
      if (!okFetch || items.length === 0) {
        // 抓取失败或明细为空：不写库，下次刷新自动重试，避免"空明细"被永久归档
        failedDetails.push({ id: entry.id, project: entry.project, audit_time: entry.audit_time });
        continue;
      }
      await env.DB.prepare(
        "INSERT OR IGNORE INTO lab_reports (id, audit_time, project, reviewer, items_json) VALUES (?, ?, ?, ?, ?)"
      ).bind(entry.id, entry.audit_time, entry.project, entry.reviewer, JSON.stringify(items)).run();
      newLabs.push({ ...entry, items });
    }

    // 增量写入超声
    const newUs = [];
    for (const u of usList) {
      if (existingUs.has(u.uid)) continue;
      await env.DB.prepare(
        "INSERT OR IGNORE INTO us_reports (uid, report_time, dept, doctor, findings, conclusion) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(u.uid, u.report_time, u.dept, u.doctor, u.findings, u.conclusion).run();
      newUs.push(u);
    }

    // 患者信息（仅当列表有数据时更新；出院后医院不再返回报告，保留最后一次信息）
    const now = new Date().toISOString();
    const stmts = [
      env.DB.prepare("INSERT INTO meta (key, value) VALUES ('last_refresh', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(now),
    ];
    if (labList.length) {
      const patient = {
        name: labList[0].name, gender: labList[0].gender, age: labList[0].age,
        bed: labList[0].bed, dept: usList[0]?.dept || "",
      };
      stmts.push(
        env.DB.prepare("INSERT INTO meta (key, value) VALUES ('patient_json', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .bind(JSON.stringify(patient))
      );
    }
    await env.DB.batch(stmts);

    // 关键指标最新值（从新增 + 已有中各报告最近一次）
    const latest = {};
    const allLabs = await env.DB.prepare("SELECT audit_time, items_json FROM lab_reports").all();
    const parsed = (allLabs.results || []).map((r) => ({
      audit_time: r.audit_time,
      items: JSON.parse(r.items_json || "[]"),
    }));
    parsed.sort((a, b) => parseDt(b.audit_time) - parseDt(a.audit_time));
    for (const [label, match] of KEY_ITEMS) {
      outer: for (const rep of parsed) {
        for (const it of rep.items) {
          if (match(it.name) && it.result !== undefined && !Number.isNaN(parseFloat(it.result))) {
            latest[label] = { value: parseFloat(it.result), flag: it.flag || "", date: (rep.audit_time || "").slice(0, 10) };
            break outer;
          }
        }
      }
    }

    return Response.json({
      ok: true,
      new_lab_count: newLabs.length,
      new_us_count: newUs.length,
      pending_count: pending.length,
      has_more: hasMore,
      failed_details: failedDetails,
      new_labs: newLabs.map((r) => ({
        id: r.id, project: r.project, audit_time: r.audit_time,
        abnormal: r.items.filter((i) => i.flag === "↑" || i.flag === "↓")
          .map((i) => ({ name: i.name, result: i.result, flag: i.flag, ref_text: i.ref_text })),
      })),
      new_us: newUs.map((u) => ({ report_time: u.report_time, conclusion: u.conclusion })),
      latest,
      refreshed_at: now,
    });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
