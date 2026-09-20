/** POST /api/analyze — 可选功能：调用 OpenAI 兼容接口生成家属版解读
 *  需要环境变量: LLM_BASE_URL, LLM_API_KEY（可选 LLM_MODEL，默认 gpt-4o-mini）
 *  未配置时返回 { ok:true, enabled:false }，前端隐藏该功能。 */
function parseDt(s) {
  const m = /(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(s || "");
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
}

function mmdd(s) {
  const m = /(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})/.exec(s || "");
  return m ? `${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : (s || "").slice(0, 10);
}

const KEY_ITEMS = [
  ["白细胞", (n) => n === "白细胞"],
  ["血红蛋白", (n) => n === "血红蛋白"],
  ["血小板", (n) => n === "血小板计数"],
  ["中性粒细胞", (n) => n === "中性粒细胞数"],
  ["CRP", (n) => n.includes("C-反应蛋白") || n.toUpperCase() === "CRP"],
];

export async function onRequestPost(context) {
  const { env } = context;
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY) {
    return Response.json({ ok: true, enabled: false, message: "未配置大模型（LLM_BASE_URL / LLM_API_KEY），AI 解读不可用" });
  }
  const model = env.LLM_MODEL || "gpt-4o-mini";
  try {
    // 取最近 14 天报告，整理关键指标序列与最近异常项
    const rows = await env.DB.prepare("SELECT audit_time, project, items_json FROM lab_reports").all();
    const reports = (rows.results || [])
      .map((r) => ({ ...r, items: JSON.parse(r.items_json || "[]"), t: parseDt(r.audit_time) }))
      .filter((r) => r.t > Date.now() - 14 * 864e5)
      .sort((a, b) => a.t - b.t);

    const series = {};
    for (const [label, match] of KEY_ITEMS) {
      series[label] = [];
      for (const rep of reports) {
        for (const it of rep.items) {
          if (match(it.name) && !Number.isNaN(parseFloat(it.result))) {
            series[label].push(`${mmdd(rep.audit_time)}=${it.result}${it.flag || ""}`);
          }
        }
      }
    }
    const latestAbn = [];
    const lastDay = Math.max(...reports.map((r) => r.t), 0);
    for (const rep of reports.filter((r) => r.t >= lastDay - 864e5)) {
      for (const it of rep.items) {
        if (it.flag === "↑" || it.flag === "↓") {
          latestAbn.push(`${it.name}=${it.result}${it.flag}(参考${it.ref_text || "-"})`);
        }
      }
    }

    const facts = [
      "近14天关键指标变化：" + Object.entries(series).map(([k, v]) => `${k}: ${v.join(" → ") || "无数据"}`).join("；"),
      "最近一天异常项：" + (latestAbn.slice(0, 40).join("，") || "无"),
    ].join("\n");

    const base = env.LLM_BASE_URL.replace(/\/+$/, "");
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "你是住院患者家属的贴心助手。根据检验数据，用通俗、温和的简体中文向非医学专业的家属说明情况。" +
              "要求：1) 只客观描述数值变化和含义，不做诊断、不预测病情、不给出治疗建议；2) 指出哪些指标需要向医生询问；" +
              "3) 结尾必须写\"以上仅供参考，请以主治医生解读为准\"；4) 控制在250字以内，分3-4个短段落。",
          },
          { role: "user", content: facts },
        ],
        temperature: 0.3,
      }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      return Response.json({ ok: false, error: `LLM 接口错误 ${resp.status}: ${t.slice(0, 300)}` }, { status: 502 });
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || "";
    return Response.json({ ok: true, enabled: true, analysis: text, model });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
