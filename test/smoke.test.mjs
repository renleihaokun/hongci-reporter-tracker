// 冒烟测试：用 test/fixtures/ 下的虚构页面验证抓取解析逻辑
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseLabList, parseLabDetail, parseUsList, splitRef,
} from "../functions/_lib/scraper.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
let fail = 0;
const eq = (a, b, msg) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) { fail++; console.log("FAIL:", msg, "\n  got:", JSON.stringify(a), "\n  exp:", JSON.stringify(b)); }
  else console.log("ok:", msg);
};

// 1) 检验列表
const list = parseLabList(readFileSync(join(FIX, "lab-list.html"), "utf8"));
eq(list.length, 2, "检验列表数量");
eq(list[0].id, "20260920SHA0030", "首条报告ID");
eq(list[0].project, "肾功能+电解质六项", "首条项目");
eq(list[0].audit_time, "2026/9/20 8:52:48", "首条审核时间");
eq(list[0].name, "张三", "患者姓名");
eq(list[0].bed, "101", "床位");

// 2) 检验详情
const items = parseLabDetail(readFileSync(join(FIX, "lab-detail.html"), "utf8"));
eq(items.length, 4, "详情项目数");
eq(items[0], { name: "白细胞", result: "1.26", flag: "↓", ref_lo: "4.00", ref_hi: "10.00", ref_text: "4~10" }, "白细胞行(☆前缀剥离)");
eq(items[1].ref_text, "100~300", "血小板参考(无小数拼接)");
eq(items[2].ref_text, "0.108~0.282", "血小板压积参考(多小数位)");

// 3) 参考范围智能拆分边界（源站丢失分隔符）
eq(splitRef("0300", "↑", 394), ["0", "300"], "0300 -> 0~300");
eq(splitRef("0.020.0", "↑", 40.4), ["0.0", "20.0"], "0.020.0 -> 0.0~20.0");
eq(splitRef("0.005.00", "↑", 5.35), ["0.00", "5.00"], "0.005.00 -> 0.00~5.00");
{
  const r = splitRef("0.501.5", "↑", 3.03);
  eq([parseFloat(r[0]), parseFloat(r[1])], [0.5, 1.5], "0.501.5 数值等价 0.5~1.5");
}
eq(splitRef("2035", "↑", 37), ["20", "35"], "2035 -> 20~35");
eq(splitRef("<5.00E+02", "↑", 6340), [null, null], "非数值参考不拆");

// 4) 超声列表
const us = parseUsList(readFileSync(join(FIX, "us-list.html"), "utf8"));
eq(us.length, 1, "超声报告数");
eq(us[0].report_time, "2026/9/15 8:18:23", "超声时间");
eq(us[0].dept, "测试病区", "超声科室");
eq(us[0].conclusion.includes("左侧颈部淋巴结肿大"), true, "超声结论");

console.log(fail === 0 ? "\n全部通过 ✔" : `\n${fail} 项失败 ✘`);
process.exit(fail === 0 ? 0 : 1);
