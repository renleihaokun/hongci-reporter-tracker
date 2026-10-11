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
    style: {},
    _attrs: {},
    _listeners: {},
    appendChild(c) { this.children.push(c); },
    append() {},
    // 记下监听器：刷新按钮的"失败明细自动重试"流程要在测试里真的跑一遍
    addEventListener(type, fn) { this._listeners[type] = fn; },
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
  "abn-card", "abn-pills", "abn-title", "btn-toggle-labs", "lab-filters",
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
    // 验证不传时间参数时，能够自动以归档中最新报告日期为锚点提取近14天数据（历史报告不丢失）
    const pNoTime = build(sample);
    check(pNoTime.includes("2.10"), "不传时间参数默认以最新归档日期为锚点");
    const pSeriesSec = (pNoTime.split("【近14天关键指标】")[1] || "").split("【最近一天异常项目】")[0];
    check(pSeriesSec.includes("09-20=2.10↓"), "历史归档下近14天指标序列仍完整提取");
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
  // 一份明细为空的报告（医院网页端不提供明细，如微生物培养）不应显示"全部正常"
  big.lab_reports.push({ id: "EMPTY1", audit_time: "2026/9/20 9:00:00", project: "培养及鉴定", items: [] });
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
    check(
      lh.includes("医院未公布明细") &&
        lh.includes("请到病区楼层自助机查询") &&
        !/培养及鉴定 · 9:00 <span class="badge ok"/.test(lh),
      "空明细报告标记为「医院未公布明细」而非「全部正常」"
    );
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
    const catList = list.map((it, i) => ({ ...it, cat: i % 2 ? "blood" : "fluid", tag: i % 2 ? "血常规" : "体液" }));
    const catFiltered = pick(catList, "", false, 10, "blood");
    check(catFiltered.shown.every((it) => it.cat === "blood") && catFiltered.shown.length === 26, "分类筛选仅保留目标类别候选(26项)");
  }
}

// ---- 报告分类与筛选功能 ----
{
  const filter = globalThis.__filterLabs;
  const catOf = globalThis.__reportCatOf;
  check(catOf({ project: "全血细胞分析" }) === "blood", "全血细胞分析归类血常规");
  check(catOf({ project: "尿常规+尿沉渣" }) === "fluid", "尿常规归类体液");
  check(catOf({ project: "肝功能+肾功能+血脂四项" }) === "biochem", "肝肾功能归类生化");
  check(catOf({ project: "超声心动图" }) === "other", "其他归类other");
  const abnOnly = filter(sample.lab_reports, "abn");
  check(abnOnly.length > 0 && abnOnly.every((r) => (r.items || []).some((i) => i.flag === "↑" || i.flag === "↓")), "仅异常过滤正确");
  const bloodOnly = filter(sample.lab_reports, "blood");
  check(bloodOnly.every((r) => catOf(r) === "blood"), "血常规类别过滤正确");
}

// ---- 最新异常速览卡片 ----
{
  globalThis.__renderAll(sample);
  check(els["abn-card"].hidden === false, "最新异常卡片正常显示");
  check(els["abn-pills"].innerHTML.includes("尿沉渣"), "最新异常包含尿沉渣异常项");
  check(els["abn-title"].textContent.includes("最新检验异常"), "异常卡片标题含最新日期与项数");
}

// ---- 客户端网络重试（指数退避）----
{
  const delay = globalThis.__retryDelayMs;
  const fr = globalThis.__fetchJsonRetry;
  if (typeof delay !== "function" || typeof fr !== "function") { console.log("FAIL: 重试钩子未暴露"); fail++; }
  else {
    check(delay(1, () => 0.5) === 800, "退避：第 1 次 0.8s");
    check(delay(2, () => 0.5) === 1600 && delay(3, () => 0.5) === 3200, "退避：指数增长 1.6s → 3.2s");
    check(delay(9, () => 0.5) === 8000, "退避上限 8s");
    check(delay(1, () => 0) === 600 && delay(1, () => 1) === 1000, "退避 ±25% 抖动");

    const realFetch = globalThis.fetch;
    const noSleep = { sleep: async () => {} };
    try {
      // 连续两次网络异常后成功
      {
        const calls = [];
        const seen = [];
        globalThis.fetch = async (url) => {
          calls.push(String(url));
          if (calls.length < 3) throw new TypeError("Failed to fetch");
          return { status: 200, json: async () => ({ ok: true, data: 1 }) };
        };
        const r = await fr("/api/refresh", { method: "POST" }, { ...noSleep, onRetry: (a, d) => seen.push([a, d]) });
        check(calls.length === 3 && r.json && r.json.ok === true, "抖动两次后自动重试成功");
        check(
          seen.length === 2 && seen[0][0] === 1 && seen[0][1] >= 600 && seen[0][1] <= 1000 &&
            seen[1][0] === 2 && seen[1][1] >= 1200 && seen[1][1] <= 2000,
          "重试提示带递增的退避秒数(" + JSON.stringify(seen) + ")"
        );
      }
      // 502 服务端故障 → 重试到用尽，且把服务端给的原因带出来
      {
        let n = 0;
        globalThis.fetch = async () => { n++; return { status: 502, json: async () => ({ ok: false, error: "boom" }) }; };
        let err = null;
        try { await fr("/api/refresh", { method: "POST" }, noSleep); } catch (e) { err = e; }
        check(n === 4, "502 重试到 4 次尝试用尽(" + n + ")");
        check(err && err.message === "boom", "重试用尽后抛出服务端给的原因(" + (err && err.message) + ")");
      }
      // 响应体截断（JSON 解析失败）→ 重试
      {
        let n = 0;
        globalThis.fetch = async () => {
          n++;
          if (n === 1) return { status: 200, json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } };
          return { status: 200, json: async () => ({ ok: true }) };
        };
        const r = await fr("/api/data", undefined, noSleep);
        check(n === 2 && r.json.ok === true, "响应体截断 → 重试后拿到完整数据");
      }
      // 确定性结果不重试：401 / 结构变化 / 404
      {
        let n401 = 0;
        globalThis.fetch = async () => { n401++; return { status: 401, json: async () => ({ ok: false }) }; };
        const r401 = await fr("/api/data", undefined, noSleep);
        check(n401 === 1 && r401.status === 401 && r401.json === null, "401 不重试，交给登录跳转");

        let nFatal = 0;
        globalThis.fetch = async () => {
          nFatal++;
          return { status: 502, json: async () => ({ ok: false, error: "医院页面结构可能已变化：xxx" }) };
        };
        const rFatal = await fr("/api/refresh", { method: "POST" }, {
          ...noSleep, isFatal: (j) => String((j && j.error) || "").includes("结构"),
        });
        check(nFatal === 1 && rFatal.json.ok === false, "医院页面结构变化不浪费重试");

        let n404 = 0;
        globalThis.fetch = async () => { n404++; return { status: 404, json: async () => ({ ok: false, error: "not found" }) }; };
        const r404 = await fr("/api/data", undefined, noSleep);
        check(n404 === 1 && r404.json.ok === false, "普通 4xx 不重试");
      }
      // 408/425 与服务端 retry.js 保持一致：算临时失败
      {
        let n = 0;
        globalThis.fetch = async () => { n++; return { status: 408, json: async () => ({ ok: false, error: "timeout" }) }; };
        let err = null;
        try { await fr("/api/data", undefined, noSleep); } catch (e) { err = e; }
        check(n === 4 && err && err.message === "timeout", "408 也算临时失败（重试 4 次后带出原因）");
      }
    } finally {
      globalThis.fetch = realFetch;
    }

    // 状态栏文案守卫：别让重试提示盖掉刷新总结
    const canShow = globalThis.__canShowRetryNotice;
    if (typeof canShow !== "function") { console.log("FAIL: canShowRetryNotice 未暴露"); fail++; }
    else {
      check(canShow("") === true, "状态栏为空 → 允许显示重试提示");
      check(canShow("本次无新增报告，当前数据已是最新。") === false, "状态栏已有刷新总结 → 不覆盖");
      els["btn-refresh"].disabled = true;
      check(canShow("") === false, "刷新进行中 → 重试提示走进度区，不抢状态栏");
      els["btn-refresh"].disabled = false;
      els["status"].textContent = "";
    }
  }
}

// ---- 失败明细的自动重试（轮级重试）----
// 回归：拿到新报告列表但明细抓取失败时，旧逻辑直接 break（has_more 为 false），
// 只在状态栏写"下次刷新会自动重试"，用户得手动再点一次。现在应当自动再发一轮。
{
  const step = globalThis.__nextRefreshStep;
  const limits = globalThis.__refreshLimits;
  const setSleep = globalThis.__setRefreshSleep;
  if (typeof step !== "function" || typeof setSleep !== "function" || !limits) {
    console.log("FAIL: 轮级重试钩子未暴露"); fail++;
  } else {
    const MAXR = limits.MAX_DETAIL_RETRY_ROUNDS;
    check(limits.MAX_REFRESH_ROUNDS === 12 && MAXR >= 1, `轮数上限存在（新报告 ${limits.MAX_REFRESH_ROUNDS} 轮 / 失败重试 ${MAXR} 轮）`);
    check(step({ hasMore: false, failedCount: 2, rounds: 1, detailRetryRounds: 0 }) === "retry_failed", "有失败明细且没有新报告 → 自动回头重试");
    check(step({ hasMore: true, failedCount: 2, rounds: 1 }) === "more", "还有新报告时先继续抓（失败项混在 pending 里，下一轮自然会被重抓）");
    check(step({ hasMore: false, failedCount: 0 }) === "stop", "没有新报告也没有失败 → 收工");
    check(step({ hasMore: false, failedCount: 1, detailRetryRounds: MAXR }) === "stop", "重试轮数用尽 → 收工（不会无限重试）");
    check(step({ hasMore: false, failedCount: 1, detailRetryRounds: MAXR - 1 }) === "retry_failed", "上限内的最后一次重试仍会执行");
    check(step({ hasMore: true, rounds: limits.MAX_REFRESH_ROUNDS }) === "stop", "新报告轮数用尽 → 收工（12 轮上限语义不变）");

    // 端到端：真的"点"一次刷新按钮，用脚本化 fetch 注入失败
    const realFetch = globalThis.fetch;
    const sleepMs = [];
    setSleep((ms) => { sleepMs.push(ms); });
    const FAIL1 = {
      ok: true, has_more: false, new_lab_count: 0, new_us_count: 0, new_labs: [], new_us: [],
      failed_details: [{ id: "FAKE1", project: "血常规", audit_time: "2026/10/9 9:00:00" }],
      no_detail_labs: [], republished: [], latest: {},
    };
    const OK1 = {
      ok: true, has_more: false, new_lab_count: 1, new_us_count: 0, new_us: [], failed_details: [],
      new_labs: [{ id: "FAKE1", project: "血常规", audit_time: "2026/10/9 9:00:00", abnormal: [] }],
      no_detail_labs: [], republished: [], latest: {},
    };
    const IDLE = { ...OK1, new_lab_count: 0, new_labs: [] };

    const drive = async (script) => {
      let n = 0;
      globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.startsWith("/api/refresh")) {
          const body = n < script.length ? script[n] : IDLE; // 脚本用尽后回一个"无事发生"，超发请求会在计数断言里露出来
          n++;
          return { status: 200, json: async () => body };
        }
        if (u === "/api/data") return { status: 200, json: async () => sample };
        throw new Error("unexpected fetch: " + u);
      };
      sleepMs.length = 0;
      els["prog-log"].children = [];
      els["status"].textContent = "";
      els["status"].className = "status";
      await els["btn-refresh"]._listeners.click();
      return {
        refreshCalls: n,
        log: els["prog-log"].children.map((c) => c.innerHTML).join("\n"),
        status: els["status"].textContent,
        statusClass: els["status"].className,
        btnDisabled: els["btn-refresh"].disabled,
      };
    };

    try {
      // A) 第一轮明细失败，第二轮（自动重试）拿到 → 不该停在失败上
      {
        const r = await drive([FAIL1, OK1]);
        check(r.refreshCalls === 2, `明细失败后自动再发一轮（/api/refresh 共 2 次，实为 ${r.refreshCalls}）`);
        check(r.log.includes("自动重试") && r.log.includes("重试成功，已入库"), "进度区显示自动重试与重试成功");
        check(!r.status.includes("抓取失败") && !r.status.includes("仍未抓到"), "重试成功后状态栏不再报失败");
        check(r.statusClass.includes("success"), "全部入库 → 状态栏标 success");
        check(sleepMs.length === 1 && sleepMs[0] >= 600 && sleepMs[0] <= 1000, `重试轮之间退避一次（${sleepMs[0]}ms，±25% 抖动）`);
        check(r.btnDisabled === false, "结束后按钮恢复可点");
      }
      // B) 医院一直不通：只重试上限轮数就收工，如实告知重试过几次
      {
        const r = await drive([FAIL1, FAIL1, FAIL1, FAIL1, IDLE]);
        check(r.refreshCalls === 1 + MAXR, `持续失败只重试 ${MAXR} 轮（/api/refresh 共 ${r.refreshCalls} 次）`);
        check(r.status.includes(`已自动重试 ${MAXR} 次仍未抓到`) && r.status.includes("血常规"), "状态栏说明已重试次数并列出没抓到的报告");
        check(!r.statusClass.includes("success"), "仍有报告没入库 → 不标 success");
        check(sleepMs.length === MAXR && sleepMs.every((ms) => ms >= 600 && ms <= 4000), `每轮重试都退避(${sleepMs.join("ms/")}ms)`);
        check(r.btnDisabled === false, "放弃自动重试后按钮仍可点，用户可手动再试");
      }
      // C) has_more 仍然驱动多轮抓取，且失败重试不会抢在它前面
      {
        const r = await drive([{ ...FAIL1, has_more: true }, OK1]);
        check(r.refreshCalls === 2, "还有新报告时照旧继续抓下一轮");
        check(sleepMs.length === 0, "has_more 轮之间不额外等待（退避只用于失败重试轮）");
        check(r.statusClass.includes("success"), "后续轮补齐后同样是成功收尾");
      }
    } finally {
      globalThis.fetch = realFetch;
      setSleep((ms) => new Promise((res) => setTimeout(res, ms)));
    }
  }
}

console.log(fail === 0 ? "\n渲染冒烟测试全部通过 ✔" : `\n${fail} 项失败 ✘`);
process.exit(fail ? 1 : 0);
