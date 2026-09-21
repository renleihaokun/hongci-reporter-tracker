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
    _attrs: {},
    appendChild(c) { this.children.push(c); },
    append() {},
    addEventListener() {},
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
  };
}
const els = {};
for (const id of [
  "patient-title", "patient-sub", "btn-refresh", "btn-ai", "btn-logout", "status", "ai-box", "ai-text", "ai-status", "ai-copy",
  "trends", "trends-empty", "labs", "uss", "us-title",
  "hero", "hero-name", "hero-tags", "hero-meta", "hero-range", "hero-updated",
  "stat-labs", "stat-us", "stat-abn", "stat-days",
  "progress", "prog-text", "prog-log", "prog-bar", "prog-time",
  "btn-metrics", "mpanel", "btn-csv",
]) {
  els[id] = makeEl(id);
}
globalThis.document = {
  getElementById: (id) => els[id] ?? null,
  createElement: () => makeEl("dynamic"),
  body: { appendChild() {}, removeChild() {} },
};
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
});
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
check(els["btn-ai"].hidden === false, "AI解读按钮常显(无需配置API)");
check(els["hero"].hidden === false, "汇总卡显示");
check(els["hero-name"].textContent.includes("张三"), "汇总卡渲染患者名");
check(els["stat-labs"].textContent === "8", "统计:检验8份(含尿沉渣与3份贫血四项)");
check(els["stat-us"].textContent === "1", "统计:超声1份");
check(els["stat-abn"].textContent === "15", "统计:异常15项(含尿沉渣白细胞↑,新增项目均正常)");
check(els["stat-days"].textContent === "4", "统计:归档4天");
check(els["hero-tags"].innerHTML.includes("九病区血液科"), "汇总卡标签渲染");
check(els["trends-empty"].hidden === true, "有趋势数据时空提示隐藏");
const trendHtml = els["trends"].children.map((c) => c.innerHTML).join("");
check(els["trends"].children.length === 8, "8 张趋势卡(核心5项+自动发现3项:铁蛋白/叶酸/维生素B12)");
check(trendHtml.includes("<svg"), "趋势 SVG 生成");
check(trendHtml.includes("↓偏低"), "异常标记");
check(trendHtml.includes("铁蛋白"), "自动发现:铁蛋白卡默认上屏");
check(els["trends"].children.some((c) => c._attrs["data-skey"] === "d:铁蛋白|other"), "自动发现卡带序列键");
check(!trendHtml.includes("网织红细胞"), "仅2份报告的网织红细胞不得默认上屏");
// 回归：尿沉渣报告（audit_time 比当天血常规更新）的同名"白细胞"不得混入血白细胞趋势
{
  const wbcCard = els["trends"].children[0].innerHTML;
  const circles = (wbcCard.match(/<circle/g) || []).length;
  check(circles === 3, "白细胞趋势仅3个血常规点(尿沉渣已排除," + circles + "点)");
  check(wbcCard.includes(">2.1<"), "白细胞最新值=血常规2.1(非尿沉渣88.0)");
  check(wbcCard.includes("参考 4~10"), "白细胞参考带=血常规4~10(非尿沉渣0~25)");
  check(!wbcCard.includes("88.0") && !wbcCard.includes("0~25"), "尿沉渣数值/参考带未混入白细胞卡");
}
const labsHtml = els["labs"].children.map((c) => c.innerHTML).join("");
check(labsHtml.includes("血常规"), "检验报告渲染");
check(labsHtml.includes("尿沉渣"), "尿沉渣报告正常展示在检验列表(只是不进趋势)");
check(labsHtml.includes("2.10"), "检验数值渲染");
check(labsHtml.includes('class="abn') || labsHtml.includes("类=\"abn\""), "异常行高亮");
check(labsHtml.includes('data-skey="core:wbc"'), "报告行带核心序列键(反向跳趋势)");
check(labsHtml.includes('data-skey="d:铁蛋白|other"'), "报告行带自动发现序列键");
check(labsHtml.includes("贫血四项"), "贫血四项报告渲染");

// ---- 添加指标面板 ----
{
  const mp = els["mpanel"].innerHTML;
  check(els["btn-metrics"].hidden === false, "有候选时「添加指标」按钮显示");
  check(mp.includes("铁蛋白") && mp.includes("叶酸") && mp.includes("维生素B12"), "面板列出3个自动发现候选");
  check(!mp.includes("网织红细胞"), "面板不含不足3份报告的项目");
  check(!mp.includes("肌酐"), "面板不含仅出现1次的项目");
}
// ---- 自动发现函数直测（血/尿同名拆分与核心去重） ----
{
  const disco = globalThis.__discoverSeries;
  if (typeof disco !== "function") { console.log("FAIL: discoverSeries 未暴露"); fail++; }
  else {
    const labs = sample.lab_reports.slice().sort((a, b) => (a.audit_time > b.audit_time ? 1 : -1));
    const list = disco(labs);
    check(list.length === 3, "自动发现恰好3个候选(铁蛋白/叶酸/维生素B12,实为" + list.length + ")");
    check(!list.some((s) => s.label === "白细胞"), "尿沉渣白细胞(1份)不成候选,血白细胞属核心不重复");
    check(!list.some((s) => s.label === "血红蛋白"), "核心指标不重复发现");
    check(list.every((s) => s.count >= 3 && s.pts.length >= 3), "候选均满足≥3份报告≥3数值点");
    check(list.every((s) => s.tag === "其他"), "贫血四项归类「其他」标签");
    const ferr = list.find((s) => s.label === "铁蛋白");
    check(ferr && ferr.pts.every((p) => p.repId && p.project && p.audit_time), "序列点携带溯源字段(报告id/项目/时间)");
  }
}
// ---- CSV 导出 ----
{
  const buildCsv = globalThis.__buildCsv;
  if (typeof buildCsv !== "function") { console.log("FAIL: buildCsv 未暴露"); fail++; }
  else {
    const csv = buildCsv(sample);
    const lines = csv.split("\r\n");
    check(csv.charCodeAt(0) === 0xfeff, "CSV 带 BOM(Excel 中文不乱码)");
    check(lines.length === 34, "CSV 33条明细+1表头(实为" + lines.length + ")");
    check(lines[0].includes("报告项目") && lines[0].includes("标本号"), "CSV 表头完整");
    check(csv.includes("铁蛋白") && csv.includes("网织红细胞百分比"), "CSV 含全部指标(不限趋势项)");
    check(!csv.includes("超声所见"), "CSV 不含超声内容");
  }
}
const usHtml = els["uss"].children.map((c) => c.innerHTML).join("");
check(usHtml.includes("左侧颈部淋巴结肿大"), "超声结论渲染");
check(els["us-title"].hidden === false, "超声标题显示");

// ---- AI 提示词构建（免 API 方案）----
{
  const build = globalThis.__buildAiPrompt;
  if (typeof build !== "function") { console.log("FAIL: buildAiPrompt 未暴露"); fail++; }
  else {
    const p = build(sample, new Date(2026, 8, 21).getTime());
    check(p.includes("白细胞 (WBC)"), "提示词含关键指标段落");
    check(p.includes("2.10"), "提示词含最新白细胞值");
    // 尿沉渣值只允许出现在"异常项目"段（带类型前缀），不得混入指标序列段
    const seriesSec = (p.split("【近14天关键指标】")[1] || "").split("【最近一天异常项目】")[0];
    check(seriesSec.includes("2.10") && !seriesSec.includes("88.0"), "尿沉渣值不进指标序列段");
    check(p.includes("尿沉渣·白细胞"), "异常项带报告类型前缀(防AI误读为血象)");
    check(p.split("88.0").length - 1 === 1, "尿沉渣数值仅作为异常项出现一次");
    check(p.includes("请以主治医生解读为准"), "提示词含免责约束");
    check(!/姓名|住院号|张三/.test(p), "提示词不含隐私字段");
  }
}

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
    check(els["btn-metrics"].hidden === true, "大数据量下无新候选(白细胞/血红蛋白均属核心),面板按钮隐藏");
    check(els["mpanel"].hidden === true && els["mpanel"].innerHTML === "", "无候选时面板收起并清空");
  }
}

// ---- 添加指标面板的折叠/筛选（真实数据 50+ 候选场景） ----
{
  const pick = globalThis.__mpPickRows;
  if (typeof pick !== "function") { console.log("FAIL: mpPickRows 未暴露"); fail++; }
  else {
    const list = Array.from({ length: 52 }, (_, i) => ({ key: "d:k" + i, label: i % 2 ? `项目${i}` : `钾测定${i}` }));
    const fold = pick(list, "", false);
    check(fold.shown.length === 10 && fold.folding === true, "52 个候选默认只显示 10 项且给展开按钮");
    const open = pick(list, "", true);
    check(open.shown.length === 52, "展开后显示全部 52 项");
    const searched = pick(list, "钾测定", false);
    check(searched.shown.length === 26 && searched.folding === false, "筛选跨全部候选搜索(26 项命中)且不再折叠");
    check(pick(list, "不存在的项目", false).shown.length === 0, "无命中时返回空列表");
  }
}

console.log(fail === 0 ? "\n渲染冒烟测试全部通过 ✔" : `\n${fail} 项失败 ✘`);
process.exit(fail ? 1 : 0);
