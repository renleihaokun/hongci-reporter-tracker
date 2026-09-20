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
for (const id of ["patient-title", "patient-sub", "btn-refresh", "btn-ai", "btn-logout", "status", "ai-box", "ai-model", "ai-text", "trends", "labs", "uss", "us-title"]) {
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

console.log(fail === 0 ? "\n渲染冒烟测试全部通过 ✔" : `\n${fail} 项失败 ✘`);
process.exit(fail ? 1 : 0);
