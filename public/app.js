/* 住院报告追踪 前端逻辑（无框架、无外部依赖） */
"use strict";

const TREND_DEFS = [
  ["白细胞 (WBC)", (n) => n === "白细胞"],
  ["血红蛋白 (Hb)", (n) => n === "血红蛋白"],
  ["血小板 (PLT)", (n) => n === "血小板计数"],
  ["中性粒细胞 (ANC)", (n) => n === "中性粒细胞数"],
  ["C-反应蛋白 (CRP)", (n) => n.includes("C-反应蛋白") || n.toUpperCase() === "CRP"],
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

/* ---------- SVG 趋势图 ---------- */
function svgChart(points, ref) {
  if (!points.length) return "";
  const W = 300, H = 96, L = 34, R = 8, T = 8, B = 16;
  const vals = points.map((p) => p.v);
  let lo = Math.min(...vals, ...(ref ? [ref[0]] : []));
  let hi = Math.max(...vals, ...(ref ? [ref[1]] : []));
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.18;
  lo -= pad; hi += pad;
  const X = (i) => L + (W - L - R) * (i / Math.max(points.length - 1, 1));
  const Y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const fmt = (x) => String(parseFloat(x.toPrecision(4)));
  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart">`;
  if (ref) {
    const y1 = Y(ref[1]), y2 = Y(ref[0]);
    s += `<rect x="${L}" y="${y1.toFixed(1)}" width="${W - L - R}" height="${(y2 - y1).toFixed(1)}" fill="#e8f5e9"/>`;
    s += `<text x="${L - 4}" y="${(y1 + 3).toFixed(1)}" font-size="8" text-anchor="end" fill="#43a047">${fmt(ref[1])}</text>`;
    s += `<text x="${L - 4}" y="${(y2 + 3).toFixed(1)}" font-size="8" text-anchor="end" fill="#43a047">${fmt(ref[0])}</text>`;
  }
  if (points.length > 1) {
    const d = points.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ");
    s += `<path d="${d}" fill="none" stroke="#1976d2" stroke-width="1.6"/>`;
  }
  points.forEach((p, i) => {
    const color = p.flag === "↑" ? "#d32f2f" : p.flag === "↓" ? "#1565c0" : "#1976d2";
    s += `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="2.6" fill="${color}"/>`;
    s += `<text x="${X(i).toFixed(1)}" y="${H - 4}" font-size="8" text-anchor="middle" fill="#888">${esc(p.day)}</text>`;
  });
  const last = points[points.length - 1];
  const lc = last.flag === "↑" ? "#d32f2f" : last.flag === "↓" ? "#1565c0" : "#333";
  s += `<text x="${X(points.length - 1).toFixed(1)}" y="${(Y(last.v) - 5).toFixed(1)}" font-size="10" font-weight="bold" text-anchor="middle" fill="${lc}">${fmt(last.v)}</text>`;
  return s + "</svg>";
}

/* ---------- 渲染 ---------- */
function renderAll(data) {
  const p = data.patient || {};
  $("patient-title").textContent = p.name ? `${p.name} 的住院报告` : "住院报告追踪";
  const bits = [p.gender, p.age && p.age + "岁", p.bed && "床位 " + p.bed, p.dept].filter(Boolean).join(" · ");
  const upd = data.last_refresh ? new Date(data.last_refresh).toLocaleString("zh-CN", { hour12: false }) : "从未";
  $("patient-sub").textContent = (bits ? bits + " · " : "") + "上次更新 " + upd;
  $("btn-ai").hidden = !data.ai_enabled;
  $("btn-logout").hidden = !data.auth_required;

  // 趋势
  const labs = (data.lab_reports || []).slice().sort((a, b) => parseDt(a.audit_time) - parseDt(b.audit_time));
  const trendsEl = $("trends");
  trendsEl.innerHTML = "";
  for (const [label, match] of TREND_DEFS) {
    const pts = [];
    let ref = null;
    for (const rep of labs) {
      for (const it of rep.items || []) {
        if (match(it.name)) {
          const v = parseFloat(it.result);
          if (Number.isNaN(v)) continue;
          pts.push({ v, day: mmdd(rep.audit_time), flag: it.flag || "", t: parseDt(rep.audit_time) });
          if (it.ref_lo && it.ref_hi) ref = [parseFloat(it.ref_lo), parseFloat(it.ref_hi)];
        }
      }
    }
    if (!pts.length) continue;
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

  // 检验报告按日期分组
  const byDay = {};
  for (const rep of data.lab_reports || []) {
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
      const abn = (rep.items || []).filter((i) => i.flag === "↑" || i.flag === "↓");
      const tm = /(\d{1,2}:\d{1,2})/.exec((rep.audit_time || "").split(" ")[1] || "")?.[1] || "";
      const tag = abn.length
        ? `<span class="badge hi">${abn.length}项异常</span>`
        : `<span class="badge ok">全部正常</span>`;
      const rows = (rep.items || []).map((it) => {
        const isAbn = it.flag === "↑" || it.flag === "↓";
        const color = it.flag === "↑" ? "#d32f2f" : it.flag === "↓" ? "#1565c0" : "#222";
        return `<tr${isAbn ? ' class="abn"' : ""}><td>${esc(it.name)}</td>` +
          `<td style="color:${color};font-weight:${isAbn ? 700 : 400}">${esc(it.result)}</td>` +
          `<td style="color:${color}">${esc(it.flag)}</td><td>${esc(it.ref_text)}</td></tr>`;
      }).join("");
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML =
        `<details${di === 0 ? " open" : ""}><summary><span>${esc(rep.project)} · ${esc(tm)} ${tag}</span><span class="arrow">▶</span></summary>` +
        `<div class="detail-body"><table><tr><th>项目</th><th>结果</th><th>提示</th><th>参考范围</th></tr>${rows}</table>` +
        `<div class="rep-meta">标本号 ${esc(rep.id)} · 审核 ${esc(rep.audit_time)}</div></div></details>`;
      labsEl.appendChild(card);
    }
  });

  // 超声
  const uss = data.us_reports || [];
  $("us-title").hidden = !uss.length;
  const usEl = $("uss");
  usEl.innerHTML = "";
  for (const u of uss) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      `<details><summary><span>超声 · ${esc(dayLabel(u.report_time))}</span><span class="arrow">▶</span></summary>` +
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
    renderAll(j);
  } catch (e) {
    showStatus("加载数据失败：" + e.message, "error");
  }
}

$("btn-refresh").addEventListener("click", async () => {
  const btn = $("btn-refresh");
  btn.disabled = true;
  btn.innerHTML = '<span class="spin">⏳</span> 正在抓取医院数据…';
  showStatus("正在连接医院查询系统，请稍候（约需 10-30 秒）…");
  try {
    const r = await fetch("/api/refresh", { method: "POST" });
    if (r.status === 401) { needLogin(); return; }
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "刷新失败");
    const lines = [];
    if (j.new_lab_count === 0 && j.new_us_count === 0) {
      lines.push("本次无新增报告，当前数据已是最新。");
    } else {
      if (j.new_lab_count) {
        lines.push(`新增检验报告 ${j.new_lab_count} 份：`);
        for (const r2 of j.new_labs) lines.push(`· ${r2.project}（${r2.audit_time}）${r2.abnormal.length ? " 异常" + r2.abnormal.length + "项" : ""}`);
      }
      if (j.new_us_count) lines.push(`新增超声报告 ${j.new_us_count} 份`);
    }
    if (j.latest && Object.keys(j.latest).length) {
      lines.push("", "关键指标最新值：");
      for (const [k, v] of Object.entries(j.latest)) lines.push(`· ${k}: ${v.value} ${v.flag || ""}（${v.date}）`);
    }
    showStatus(lines.join("\n"), "success");
    await loadData();
  } catch (e) {
    showStatus("刷新失败：" + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "🔄 获取最新报告";
  }
});

$("btn-ai").addEventListener("click", async () => {
  const btn = $("btn-ai");
  btn.disabled = true;
  btn.innerHTML = '<span class="spin">⏳</span> AI 分析中…';
  try {
    const r = await fetch("/api/analyze", { method: "POST" });
    if (r.status === 401) { needLogin(); return; }
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "分析失败");
    if (!j.enabled) { showStatus(j.message || "未配置大模型", "error"); return; }
    $("ai-box").hidden = false;
    $("ai-model").textContent = j.model ? "· " + j.model : "";
    $("ai-text").textContent = j.analysis;
  } catch (e) {
    showStatus("AI 分析失败：" + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "🤖 AI 解读";
  }
});

$("btn-logout").addEventListener("click", async () => {
  await fetch("/api/login", { method: "DELETE" });
  location.reload();
});

loadData();
