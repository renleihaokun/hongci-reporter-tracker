// 用最小 DOM stub 在 Node 中执行 app.js 的渲染逻辑，捕获运行时错误
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sample = JSON.parse(readFileSync(join(ROOT, "test", "sample-data.json"), "utf8"));

// ---- 最小 DOM stub ----
function makeEl(id) {
  return {
    id,
    children: [],
    innerHTML: "",
    textContent: "",
    hidden: false,
    disabled: false,
    className: "",
    appendChild(c) { this.children.push(c); },
    addEventListener() {},
  };
}
const els = {};
for (const id of [
  "patient-title", "patient-sub", "btn-refresh", "btn-ai", "btn-logout", "status", "ai-box", "ai-model", "ai-text",
  "trends", "trends-empty", "labs", "uss", "us-title",
  "hero", "hero-name", "hero-tags", "hero-meta", "hero-range", "hero-updated",
  "stat-labs", "stat-us", "stat-abn", "stat-days",
  "progress", "prog-text", "prog-log", "prog-bar", "prog-time",
]) {
  els[id] = makeEl(id);
}
globalThis.document = {
  getElementById: (id) => els[id] ?? null,
  createElement: () => makeEl("dynamic"),
};
globalThis.fetch = async (url) => ({
  json: async () => {
    if (url === "/api/data") return sample;
    return { ok: true };
  },
});

// ---- 执行 app.js ----
const code = readFileSync(join(ROOT, "public", "app.js"), "utf8");
await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
await new Promise((r) => setTimeout(r, 100)); // 等待 loadData 完成

// ---- 断言 ----
let fail = 0;
const check = (cond, msg) => { console.log((cond ? "ok: " : "FAIL: ") + msg); if (!cond) fail++; };

check(els["patient-title"].textContent.includes("张三"), "标题渲染患者名");
check(els["patient-sub"].textContent.includes("床位 942"), "副标题渲染床位");
check(els["btn-ai"].hidden === true, "未配置AI时按钮隐藏");
check(els["hero"].hidden === false, "汇总卡显示");
check(els["hero-name"].textContent.includes("张三"), "汇总卡渲染患者名");
check(els["stat-labs"].textContent === "4", "统计:检验4份");
check(els["stat-us"].textContent === "1", "统计:超声1份");
check(els["stat-abn"].textContent === "14", "统计:异常14项");
check(els["stat-days"].textContent === "4", "统计:归档4天");
check(els["hero-tags"].innerHTML.includes("九病区血液科"), "汇总卡标签渲染");
check(els["trends-empty"].hidden === true, "有趋势数据时空提示隐藏");
const trendHtml = els["trends"].children.map((c) => c.innerHTML).join("");
check(els["trends"].children.length === 5, "5 张趋势卡");
check(trendHtml.includes("<svg"), "趋势 SVG 生成");
check(trendHtml.includes("↓偏低"), "异常标记");
const labsHtml = els["labs"].children.map((c) => c.innerHTML).join("");
check(labsHtml.includes("血常规"), "检验报告渲染");
check(labsHtml.includes("1.26"), "检验数值渲染");
check(labsHtml.includes("类=\"abn\"") || labsHtml.includes('class="abn"'), "异常行高亮");
const usHtml = els["uss"].children.map((c) => c.innerHTML).join("");
check(usHtml.includes("左侧颈部淋巴结肿大"), "超声结论渲染");
check(els["us-title"].hidden === false, "超声标题显示");

// ---- 边界场景：长期归档大数据量 + 空明细报告 ----
{
  // 构造 60 天每天一份血常规 → 趋势图应只画最近 40 点、标签抽稀不崩
  const big = JSON.parse(JSON.stringify(sample));
  big.lab_reports = [];
  for (let d = 60; d >= 1; d--) {
    const day = String(d % 28 + 1).padStart(2, "0");
    const mon = d > 28 ? "8" : "9";
    big.lab_reports.push({
      id: "BIG" + d,
      audit_time: `2026/${mon}/${day} 8:30:00`,
      project: "血常规",
      items: [
        { name: "白细胞", result: (2 + Math.sin(d) ).toFixed(2), flag: "↓", ref_lo: "4.00", ref_hi: "10.00", ref_text: "4~10" },
        { name: "血红蛋白", result: String(90 + (d % 15)), flag: "↓", ref_lo: "120", ref_hi: "160", ref_text: "120~160" },
      ],
    });
  }
  // 一份明细为空的报告（抓取失败待重试）不应显示"全部正常"
  big.lab_reports.push({ id: "EMPTY1", audit_time: "2026/9/20 9:00:00", project: "异常结构报告", items: [] });
  // 怪参考范围不应产生 NaN 图表
  big.lab_reports.push({
    id: "WEIRD1", audit_time: "2026/9/20 9:10:00", project: "定性报告",
    items: [{ name: "某定性项", result: "阴性", flag: "", ref_lo: null, ref_hi: null, ref_text: "阴性" }],
  });

  for (const id of Object.keys(els)) { els[id].children = []; els[id].innerHTML = ""; els[id].textContent = ""; }
  // 直接调 renderAll（app.js 已在上方 import 作用域内定义）
  const renderAllFn = globalThis.__renderAll;
  if (typeof renderAllFn !== "function") { console.log("FAIL: renderAll 未暴露"); fail++; }
  else {
    renderAllFn(big);
    const th = els["trends"].children.map((c) => c.innerHTML).join("");
    const circles = (th.match(/<circle/g) || []).length;
    check(circles > 0 && circles <= 40 * 5, "大数据量趋势图限点绘制(" + circles + "点)");
    const labelCount = (th.match(/<text[^>]*>0/g) || []).length;
    check(labelCount <= 50, "X轴标签已抽稀(" + labelCount + "个)");
    check(!th.includes("NaN"), "图表无 NaN");
    const lh = els["labs"].children.map((c) => c.innerHTML).join("");
    check(lh.includes("明细抓取失败") && !lh.includes("异常结构报告 · 09:00 <span class=\"badge ok\""), "空明细报告正确标记");
  }
}

console.log(fail === 0 ? "\n渲染冒烟测试全部通过 ✔" : `\n${fail} 项失败 ✘`);
process.exit(fail ? 1 : 0);
