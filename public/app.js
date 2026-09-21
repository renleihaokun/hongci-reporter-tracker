/* 住院报告追踪 前端逻辑（无框架、无外部依赖） */
"use strict";

/* 报告类型过滤（与 functions/api/refresh.js 的 KEY_ITEMS 保持同步）：
   血常规四项只从血常规类报告取数——尿沉渣报告里也有裸名"白细胞"（/μL，参考 0~25），
   与血常规的白细胞（×10⁹/L，参考 4~10）同名不同物，混入会污染趋势与参考区间带；
   CRP 散布在各类生化组合中（组合名不可枚举），改用体液黑名单排除法。
   白名单失效表现为图变空白（显性），黑名单漏排会静默混入脏数据（隐性），故血指标用白名单。 */
const BLOOD_PANEL_RE = /血常规|血细胞分析|全血细胞/;
const FLUID_PANEL_RE = /尿|粪|便|大便|胸水|腹水|脑脊液|分泌物|痰|前列腺|灌洗|胃液|胆汁/;
const bloodMetric = (match) => (rep, it) => BLOOD_PANEL_RE.test(rep.project || "") && match(String(it.name || ""));
const serumMetric = (match) => (rep, it) => !FLUID_PANEL_RE.test(rep.project || "") && match(String(it.name || ""));

const TREND_DEFS = [
  ["白细胞 (WBC)", bloodMetric((n) => n === "白细胞")],
  ["血红蛋白 (Hb)", bloodMetric((n) => n === "血红蛋白")],
  ["血小板 (PLT)", bloodMetric((n) => n === "血小板计数")],
  ["中性粒细胞 (ANC)", bloodMetric((n) => n === "中性粒细胞数")],
  ["C-反应蛋白 (CRP)", serumMetric((n) => n.includes("C-反应蛋白") || n.toUpperCase() === "CRP")],
];

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function parseDt(s) {
  const m = /(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(s || "");
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
}
const dayLabel = (s) => {
  const m = /(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})/.exec(s || "");
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : "未知日期";
};
const mmdd = (s) => {
  const m = /(\d{1,2})[\/.](\d{1,2})/.exec((s || "").slice(4));
  return m ? `${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
};

function showStatus(text, kind) {
  const el = $("status");
  el.hidden = !text;
  el.textContent = text || "";
  el.className = "status" + (kind ? " " + kind : "");
}

/* 不可重试的错误（如医院页面结构变化），直接抛给用户 */
class FatalErr extends Error {}

/* 本次刷新新增的报告标记（会话内高亮"新"） */
function loadNewMarks() {
  try {
    return {
      labs: new Set(JSON.parse(sessionStorage.getItem("hc_new_lab_ids") || "[]")),
      us: new Set(JSON.parse(sessionStorage.getItem("hc_new_us_ids") || "[]")),
    };
  } catch {
    return { labs: new Set(), us: new Set() };
  }
}

/* ---------- SVG 趋势图 ---------- */
const MAX_CHART_POINTS = 40; // 归档变长后只画最近 N 个点，避免挤压失真

function svgChart(allPoints, ref) {
  if (!allPoints.length) return "";
  const points = allPoints.length > MAX_CHART_POINTS ? allPoints.slice(-MAX_CHART_POINTS) : allPoints;
  const labelEvery = Math.max(1, Math.ceil(points.length / 8)); // X 轴标签抽稀，最多约 8 个
  const W = 320, H = 118, L = 40, R = 10, T = 10, B = 18;
  const vals = points.map((p) => p.v).filter((v) => Number.isFinite(v));
  if (!vals.length) return "";
  let lo = Math.min(...vals, ...(ref ? [ref[0]] : []));
  let hi = Math.max(...vals, ...(ref ? [ref[1]] : []));
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.18;
  lo -= pad; hi += pad;
  const X = (i) => L + (W - L - R) * (i / Math.max(points.length - 1, 1));
  const Y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const fmt = (x) => String(parseFloat(x.toPrecision(4)));
  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart">`;
  // 参考区间绿色带
  if (ref) {
    const y1 = Y(ref[1]), y2 = Y(ref[0]);
    s += `<rect x="${L}" y="${y1.toFixed(1)}" width="${W - L - R}" height="${(y2 - y1).toFixed(1)}" fill="#e8f5e9"/>`;
    s += `<text x="${L - 4}" y="${(y1 + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="#43a047">${fmt(ref[1])}</text>`;
    s += `<text x="${L - 4}" y="${(y2 + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="#43a047">${fmt(ref[0])}</text>`;
  }
  // 水平网格线
  for (let g = 1; g <= 3; g++) {
    const gy = T + (H - T - B) * (g / 4);
    s += `<line x1="${L}" y1="${gy.toFixed(1)}" x2="${W - R}" y2="${gy.toFixed(1)}" stroke="#eceff1" stroke-width="1"/>`;
  }
  // 折线 + 面积填充
  if (points.length > 1) {
    const d = points.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ");
    const baseY = H - B;
    s += `<path d="${d} L${X(points.length - 1).toFixed(1)},${baseY} L${X(0).toFixed(1)},${baseY} Z" fill="rgba(25,118,210,.08)"/>`;
    s += `<path d="${d}" fill="none" stroke="#1976d2" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  points.forEach((p, i) => {
    const color = p.flag === "↑" ? "#d32f2f" : p.flag === "↓" ? "#1565c0" : "#1976d2";
    s += `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="2.8" fill="${color}"/>`;
    if (i % labelEvery === 0 || i === points.length - 1) {
      s += `<text x="${X(i).toFixed(1)}" y="${H - 5}" font-size="9" text-anchor="middle" fill="#90a4ae">${esc(p.day)}</text>`;
    }
  });
  const last = points[points.length - 1];
  const lc = last.flag === "↑" ? "#d32f2f" : last.flag === "↓" ? "#1565c0" : "#333";
  s += `<text x="${X(points.length - 1).toFixed(1)}" y="${(Y(last.v) - 6).toFixed(1)}" font-size="11" font-weight="bold" text-anchor="middle" fill="${lc}">${fmt(last.v)}</text>`;
  return s + "</svg>";
}

/* 最近一次 /api/data 的全量数据（AI 提示词在本地构建，无需再请求服务端） */
let currentData = null;

/* ---------- 渲染 ---------- */
function renderAll(data) {
  const p = data.patient || {};
  const upd = data.last_refresh ? new Date(data.last_refresh).toLocaleString("zh-CN", { hour12: false }) : "从未";
  $("patient-title").textContent = p.name ? `${p.name} 的住院报告` : "住院报告追踪";
  const bits = [p.gender, p.age && p.age + "岁", p.bed && "床位 " + p.bed, p.dept].filter(Boolean).join(" · ");
  $("patient-sub").textContent = (bits ? bits + " · " : "") + "上次更新 " + upd;
  $("btn-logout").hidden = !data.auth_required;

  const labs = (data.lab_reports || []).slice().sort((a, b) => parseDt(a.audit_time) - parseDt(b.audit_time));
  const uss = data.us_reports || [];
  const marks = loadNewMarks();

  /* 患者信息汇总卡 */
  const abnCount = labs.reduce((n, r) => n + (r.items || []).filter((i) => i.flag === "↑" || i.flag === "↓").length, 0);
  const daySet = new Set(labs.map((r) => dayLabel(r.audit_time)).filter((d) => d !== "未知日期"));
  const sortedDays = [...daySet].sort();
  $("hero").hidden = false;
  $("hero-name").textContent = p.name || "住院报告";
  $("hero-tags").innerHTML = [p.gender, p.age && p.age + "岁", p.bed && "床位 " + p.bed, p.dept]
    .filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  $("hero-meta").textContent = "数据来自院方公开查询系统 · 全量归档于 Cloudflare D1";
  $("stat-labs").textContent = String(labs.length);
  $("stat-us").textContent = String(uss.length);
  $("stat-abn").textContent = String(abnCount);
  $("stat-days").textContent = String(daySet.size);
  $("hero-range").textContent = sortedDays.length ? `归档区间 ${sortedDays[0]} ~ ${sortedDays[sortedDays.length - 1]}` : "暂无归档数据";
  $("hero-updated").textContent = "上次更新 " + upd;

  /* 趋势 */
  const trendsEl = $("trends");
  trendsEl.innerHTML = "";
  let anyTrend = false;
  for (const [label, match] of TREND_DEFS) {
    const pts = [];
    let ref = null;
    for (const rep of labs) {
      for (const it of rep.items || []) {
        if (match(rep, it)) {
          const v = parseFloat(it.result);
          if (!Number.isFinite(v)) continue;
          pts.push({ v, day: mmdd(rep.audit_time), flag: it.flag || "", t: parseDt(rep.audit_time) });
          const rlo = parseFloat(it.ref_lo), rhi = parseFloat(it.ref_hi);
          if (Number.isFinite(rlo) && Number.isFinite(rhi) && rhi > rlo) ref = [rlo, rhi];
        }
      }
    }
    if (!pts.length) continue;
    anyTrend = true;
    const last = pts[pts.length - 1];
    const cls = last.flag === "↑" ? "hi" : last.flag === "↓" ? "lo" : "ok";
    const arrow = last.flag === "↑" ? "↑偏高" : last.flag === "↓" ? "↓偏低" : "正常";
    const card = document.createElement("div");
    card.className = "card trend";
    card.innerHTML =
      `<h3>${esc(label)} <span class="badge ${cls}">${arrow}</span></h3>` +
      `<div class="big ${cls}">${last.v}</div>` +
      `<div class="sub">${ref ? `参考 ${ref[0]}~${ref[1]} · ` : ""}${esc(last.day)}</div>` +
      svgChart(pts, ref);
    trendsEl.appendChild(card);
  }
  $("trends-empty").hidden = anyTrend;

  /* 检验报告按日期分组 */
  const byDay = {};
  for (const rep of labs) {
    const d = dayLabel(rep.audit_time);
    (byDay[d] = byDay[d] || []).push(rep);
  }
  const labsEl = $("labs");
  labsEl.innerHTML = "";
  const days = Object.keys(byDay).sort().reverse();
  if (!days.length) labsEl.innerHTML = '<div class="card">暂无数据，点击上方"获取最新报告"</div>';
  days.forEach((day, di) => {
    const h = document.createElement("div");
    h.className = "day";
    h.textContent = day;
    labsEl.appendChild(h);
    for (const rep of byDay[day].sort((a, b) => parseDt(b.audit_time) - parseDt(a.audit_time))) {
      const items = rep.items || [];
      const abn = items.filter((i) => i.flag === "↑" || i.flag === "↓");
      const tm = /(\d{1,2}:\d{1,2})/.exec((rep.audit_time || "").split(" ")[1] || "")?.[1] || "";
      const isNew = marks.labs.has(rep.id);
      const tag = !items.length
        ? `<span class="badge" style="background:#fff3e0;color:#e65100">明细抓取失败</span>`
        : abn.length
          ? `<span class="badge hi">${abn.length}项异常</span>`
          : `<span class="badge ok">全部正常</span>`;
      const rows = items.map((it) => {
        const isAbn = it.flag === "↑" || it.flag === "↓";
        const color = it.flag === "↑" ? "#d32f2f" : it.flag === "↓" ? "#1565c0" : "#222";
        return `<tr${isAbn ? ' class="abn"' : ""}><td>${esc(it.name)}</td>` +
          `<td style="color:${color};font-weight:${isAbn ? 700 : 400}">${esc(it.result)}</td>` +
          `<td style="color:${color}">${esc(it.flag)}</td><td>${esc(it.ref_text)}</td></tr>`;
      }).join("");
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML =
        `<details${di === 0 ? " open" : ""}><summary><span>${esc(rep.project)} · ${esc(tm)} ${tag}${isNew ? '<span class="new-tag">新</span>' : ""}</span><span class="arrow">▶</span></summary>` +
        `<div class="detail-body"><table><tr><th>项目</th><th>结果</th><th>提示</th><th>参考范围</th></tr>${rows}</table>` +
        `<div class="rep-meta">标本号 ${esc(rep.id)} · 审核 ${esc(rep.audit_time)}</div></div></details>`;
      labsEl.appendChild(card);
    }
  });

  /* 超声 */
  $("us-title").hidden = !uss.length;
  const usEl = $("uss");
  usEl.innerHTML = "";
  for (const u of uss) {
    const isNew = marks.us.has(u.report_time);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      `<details><summary><span>超声 · ${esc(dayLabel(u.report_time))}${isNew ? '<span class="new-tag">新</span>' : ""}</span><span class="arrow">▶</span></summary>` +
      `<div class="detail-body"><div class="rep-meta">${esc(u.dept)} · 医生 ${esc(u.doctor)}</div>` +
      `<div class="us-txt"><b>超声所见：</b>\n${esc(u.findings)}</div>` +
      `<div class="us-txt"><b>超声结论：</b>\n${esc(u.conclusion)}</div></div></details>`;
    usEl.appendChild(card);
  }
}

/* ---------- 动作 ---------- */
function needLogin() {
  showStatus("需要输入访问密码，正在跳转登录页…");
  setTimeout(() => location.reload(), 800);
}

async function loadData() {
  try {
    const r = await fetch("/api/data");
    if (r.status === 401) { needLogin(); return; }
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "加载失败");
    currentData = j;
    renderAll(j);
  } catch (e) {
    // 网络抖动常见：给出可点的重试入口，不用整页刷新
    const el = $("status");
    el.hidden = false;
    el.className = "status error";
    el.innerHTML = "";
    el.append("加载数据失败：" + e.message + "（多为网络波动） ");
    const retry = document.createElement("button");
    retry.className = "retry-btn";
    retry.textContent = "点我重试";
    retry.addEventListener("click", () => loadData());
    el.appendChild(retry);
  }
}

$("btn-refresh").addEventListener("click", async () => {
  const btn = $("btn-refresh");
  const prog = $("progress"), pText = $("prog-text"), pLog = $("prog-log"), pBar = $("prog-bar"), pTime = $("prog-time");
  btn.disabled = true;
  btn.innerHTML = '<span class="spin">⏳</span> 正在抓取…';
  prog.hidden = false;
  pLog.innerHTML = "";
  pBar.style.width = "0%";
  const t0 = Date.now();
  const tick = setInterval(() => { pTime.textContent = Math.round((Date.now() - t0) / 1000) + "s"; }, 500);
  const logLine = (html) => {
    const div = document.createElement("div");
    div.innerHTML = html;
    pLog.appendChild(div);
    if (pLog.scrollTo) pLog.scrollTop = pLog.scrollHeight;
  };
  try {
    // 分批抓取：每轮 8 份（服务端上限 40），抓到多少显示多少，边抓边看
    const acc = { new_lab_count: 0, new_us_count: 0, new_labs: [], new_us: [], failed_details: [], latest: null };
    let totalNew = null;
    let lastHasMore = false;
    for (let round = 1; round <= 12; round++) {
      pText.textContent = round === 1 ? "正在连接医院查询系统，获取报告列表…" : `第 ${round} 轮：继续抓取报告明细…`;
      // 网络不稳自动重试：服务端按"已入库"去重，重复请求无副作用
      let j = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = await fetch("/api/refresh?limit=8", { method: "POST" });
          if (r.status === 401) { needLogin(); return; }
          j = await r.json();
          if (!j.ok && String(j.error || "").includes("结构")) throw new FatalErr(j.error || "医院页面结构变化");
          break;
        } catch (e) {
          lastErr = e;
          j = null;
          if (e instanceof FatalErr) throw e;
          if (attempt < 3) {
            pText.textContent = `网络不稳定，3 秒后自动重试（第 ${attempt}/3 次）…`;
            await new Promise((res) => setTimeout(res, 3000));
          }
        }
      }
      if (!j) throw lastErr || new Error("刷新失败");
      if (!j.ok) throw new Error(j.error || "刷新失败");
      lastHasMore = !!j.has_more;
      if (totalNew === null && typeof j.pending_count === "number" && j.pending_count > 0) {
        totalNew = j.pending_count;
        logLine(`发现 <b>${totalNew}</b> 份新检验报告，开始抓取明细`);
      }
      if (j.new_us_count) logLine(`<span class="ok">＋ 新增超声报告 ${j.new_us_count} 份</span>`);
      for (const nl of j.new_labs || []) {
        const ab = nl.abnormal.length ? `，<span class="warn">${nl.abnormal.length} 项异常</span>` : "";
        logLine(`<span class="ok">＋ ${esc(nl.project)}</span>（${esc(String(nl.audit_time || "").replace(/\s+/g, " "))}）${ab}`);
      }
      for (const f of j.failed_details || []) logLine(`<span class="warn">✗ ${esc(f.project)} 明细抓取失败，下次自动重试</span>`);
      acc.new_lab_count += j.new_lab_count || 0;
      acc.new_us_count += j.new_us_count || 0;
      acc.new_labs.push(...(j.new_labs || []));
      acc.new_us.push(...(j.new_us || []));
      acc.failed_details.push(...(j.failed_details || []));
      acc.latest = j.latest || acc.latest;
      if (totalNew) pBar.style.width = Math.min(100, Math.round((acc.new_lab_count / totalNew) * 100)) + "%";
      pText.textContent = totalNew
        ? `已入库 ${acc.new_lab_count} / ${totalNew} 份检验报告…`
        : `已入库 ${acc.new_lab_count} 份检验报告…`;
      loadData().catch(() => {}); // 增量渲染：抓到的立刻上屏
      if (!j.has_more) break;
    }
    clearInterval(tick);
    pBar.style.width = "100%";
    pText.textContent = "抓取完成";
    // 记住本次新增，用于页面上"新"标记（会话内有效）
    try {
      sessionStorage.setItem("hc_new_lab_ids", JSON.stringify(acc.new_labs.map((n) => n.id)));
      sessionStorage.setItem("hc_new_us_ids", JSON.stringify(acc.new_us.map((u) => u.report_time)));
    } catch {}

    const lines = [];
    if (acc.new_lab_count === 0 && acc.new_us_count === 0) {
      lines.push("本次无新增报告，当前数据已是最新。");
    } else {
      if (acc.new_lab_count) {
        lines.push(`新增检验报告 ${acc.new_lab_count} 份：`);
        for (const r2 of acc.new_labs) lines.push(`· ${r2.project}（${r2.audit_time}）${r2.abnormal.length ? " 异常" + r2.abnormal.length + "项" : ""}`);
      }
      if (acc.new_us_count) lines.push(`新增超声报告 ${acc.new_us_count} 份`);
    }
    if (lastHasMore) lines.push("", "⚠️ 报告较多，一次没抓完，再点一次按钮继续。");
    if (acc.failed_details.length) {
      lines.push("", `⚠️ ${acc.failed_details.length} 份报告明细抓取失败，下次刷新会自动重试：`);
      for (const f of acc.failed_details) lines.push(`· ${f.project}（${f.audit_time}）`);
    }
    if (acc.latest && Object.keys(acc.latest).length) {
      lines.push("", "关键指标最新值：");
      for (const [k, v] of Object.entries(acc.latest)) lines.push(`· ${k}: ${v.value} ${v.flag || ""}（${v.date}）`);
    }
    showStatus(lines.join("\n"), acc.failed_details.length || lastHasMore ? "" : "success");
    await loadData();
    setTimeout(() => { prog.hidden = true; }, 2500);
  } catch (e) {
    clearInterval(tick);
    showStatus("刷新失败：" + e.message + "\n已入库的报告不会丢，点上面按钮重试会从断点继续。", "error");
  } finally {
    clearInterval(tick);
    btn.disabled = false;
    btn.innerHTML = "🔄 获取最新报告";
  }
});

/* ---------- AI 解读（免 API 方案）----------
 * 前端已持有 /api/data 全量数据，本地构建提示词并复制到剪贴板，
 * 引导家属去 DeepSeek 网页版/App 粘贴分析，服务端零 LLM 依赖。 */
function buildAiPrompt(data, nowMs = Date.now()) {
  const labs = (data.lab_reports || [])
    .slice()
    .sort((a, b) => parseDt(a.audit_time) - parseDt(b.audit_time));
  const recent = labs.filter((r) => parseDt(r.audit_time) > nowMs - 14 * 864e5);
  const series = TREND_DEFS.map(([label, match]) => {
    const vals = [];
    for (const rep of recent) {
      for (const it of rep.items || []) {
        if (match(rep, it) && !Number.isNaN(parseFloat(it.result))) {
          vals.push(`${mmdd(rep.audit_time)}=${it.result}${it.flag || ""}`);
        }
      }
    }
    return `${label}: ${vals.join(" → ") || "无数据"}`;
  });
  const lastDay = Math.max(0, ...labs.map((r) => parseDt(r.audit_time)));
  const abn = [];
  for (const rep of labs.filter((r) => parseDt(r.audit_time) >= lastDay - 864e5)) {
    for (const it of rep.items || []) {
      if (it.flag === "↑" || it.flag === "↓") {
        abn.push(`${rep.project}·${it.name}=${it.result}${it.flag}(参考${it.ref_text || "-"})`);
      }
    }
  }
  return (
    "你是住院患者家属的贴心助手。根据下面的检验数据，用通俗、温和的简体中文向非医学专业的家属说明情况。\n" +
    "要求：1) 只客观描述数值变化和含义，不做诊断、不预测病情、不给出治疗建议；" +
    "2) 指出哪些指标需要向医生询问；3) 结尾必须写\"以上仅供参考，请以主治医生解读为准\"；" +
    "4) 控制在250字以内，分3-4个短段落。\n\n" +
    "【近14天关键指标】\n" + series.join("\n") +
    "\n\n【最近一天异常项目】\n" + (abn.slice(0, 40).join("\n") || "无")
  );
}

/* 剪贴板：新式 API 优先，老 webview（如微信内置浏览器）降级 execCommand，
 * 仍失败时指引卡会展示全文供长按手动复制（页面另有 user-select:all 兜底） */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:-999px;opacity:0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  return ok;
}

function setAiStatus(copied) {
  const st = $("ai-status");
  st.hidden = false;
  st.className = "ai-status " + (copied ? "ok" : "warn");
  st.textContent = copied
    ? "✓ 分析提示词已复制，去 DeepSeek 粘贴发送即可"
    : "⚠ 自动复制被浏览器拒绝：展开下方提示词，长按全选后手动复制";
}

$("btn-ai").addEventListener("click", async () => {
  if (!currentData) { showStatus("数据还没加载好，稍候再点", "error"); return; }
  const prompt = buildAiPrompt(currentData);
  $("ai-text").textContent = prompt;
  $("ai-box").hidden = false;
  setAiStatus(await copyText(prompt));
  if ($("ai-box").scrollIntoView) $("ai-box").scrollIntoView({ behavior: "smooth", block: "nearest" });
});

const aiCopyBtn = $("ai-copy");
if (aiCopyBtn) aiCopyBtn.addEventListener("click", async () => {
  const prompt = currentData ? buildAiPrompt(currentData) : $("ai-text").textContent || "";
  setAiStatus(await copyText(prompt));
});

$("btn-logout").addEventListener("click", async () => {
  await fetch("/api/login", { method: "DELETE" });
  location.reload();
});

loadData();

// 测试钩子（浏览器中 window 存在，不生效；Node 冒烟测试用）
if (typeof window === "undefined") {
  globalThis.__renderAll = renderAll;
  globalThis.__buildAiPrompt = buildAiPrompt;
}
