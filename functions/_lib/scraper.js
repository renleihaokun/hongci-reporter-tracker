/**
 * 医院查询页抓取与解析（苏大附一院弘慈血液病医院查询系统）
 * 站点为 Classic ASP + GBK 编码，查询无需鉴权（住院号即凭证），无需会话 Cookie。
 */

export const DEFAULT_BASE = "http://wx.hcxyb.cn:88/";

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 " +
  "MicroMessenger/8.0.47 NetType/WIFI Language/zh_CN";

async function fetchText(url, params) {
  const init = { headers: { "User-Agent": UA } };
  if (params) {
    init.method = "POST";
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(params).toString();
  }
  const resp = await fetch(url, init);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const buf = await resp.arrayBuffer();
  return new TextDecoder("gb18030").decode(buf);
}

function stripTags(s) {
  return (s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\r/g, "")
    .trim();
}

/** 把一个报告卡片块里的 <td> 抽成 {标签: 值} */
function cellsKv(block) {
  const kv = {};
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = cellRe.exec(block)) !== null) {
    const t = stripTags(m[1]);
    const mm = /^([一-龥A-Za-z]+)：\s*([\s\S]*)$/.exec(t);
    if (mm) kv[mm[1]] = mm[2].trim();
  }
  return kv;
}

/* ---------- 参考范围智能拆分 ----------
 * 源站数据丢失分隔符，如 "4.0010.00" 实为 4.00~10.00、"0300" 实为 0~300。
 * 用结果值 + 提示箭头(↑/↓)一致性在候选切分点中择优。 */
const NUM_RE = /^\d+(\.\d+)?$/;

export function splitRef(raw, flag, resultNum) {
  const s = (raw || "").trim();
  if (/[~～]/.test(s) || /(?<=\d)-(?=\d)/.test(s)) {
    const parts = s.split(/[~～]|(?<=\d)-(?=\d)/);
    if (parts.length === 2) return [parts[0].trim(), parts[1].trim()];
    return [null, null];
  }
  if (!s || !/^\d/.test(s)) return [null, null];
  const cands = [];
  for (let i = 1; i < s.length; i++) {
    const a = s.slice(0, i);
    const b = s.slice(i);
    if (a.endsWith(".") || b.startsWith(".")) continue;
    if (!NUM_RE.test(a) || !NUM_RE.test(b)) continue;
    const fa = parseFloat(a);
    const fb = parseFloat(b);
    if (fb <= fa) continue;
    let score = 0;
    if (fa > 0) {
      const ratio = fb / fa;
      if (ratio >= 0.2 && ratio <= 20) score += 3;
    }
    if (resultNum !== null && !Number.isNaN(resultNum)) {
      if (flag === "↑" && resultNum > fb) score += 5;
      else if (flag === "↓" && resultNum < fa) score += 5;
      else if ((!flag || flag === "") && resultNum >= fa && resultNum <= fb) score += 5;
    }
    const da = a.includes(".") ? a.split(".")[1].length : 0;
    const db = b.includes(".") ? b.split(".")[1].length : 0;
    score -= Math.abs(da - db);
    if (b.length > 1 && b.startsWith("0") && !b.startsWith("0.")) score -= 2;
    cands.push([score, a, b]);
  }
  if (!cands.length) return [null, null];
  cands.sort((x, y) => y[0] - x[0]);
  return [cands[0][1], cands[0][2]];
}

function fmtNum(x) {
  const f = parseFloat(x);
  return Number.isNaN(f) ? x || "" : String(parseFloat(f.toPrecision(12)));
}

/* ---------- 列表解析 ---------- */
export function parseLabList(page) {
  const m = /<table class="zebra">([\s\S]*?)<\/table>/.exec(page);
  if (!m) return [];
  const blocks = m[1].split(/(?=<tr>\s*<td>姓名)/);
  const out = [];
  for (const b of blocks) {
    const rid = /bh\.asp\?id=([A-Za-z0-9]+)/.exec(b);
    if (!rid) continue;
    const kv = cellsKv(b);
    if (!kv["审核时间"] || !kv["项目"]) continue;
    out.push({
      id: rid[1],
      name: kv["姓名"] || "",
      gender: kv["性别"] || "",
      age: kv["年龄"] || "",
      bed: kv["床位"] || "",
      audit_time: kv["审核时间"] || "",
      reviewer: kv["审核者"] || "",
      project: kv["项目"] || "",
    });
  }
  return out;
}

export function parseLabDetail(page) {
  const m = /<table class="zebra">([\s\S]*?)<\/table>/.exec(page);
  if (!m) return [];
  const items = [];
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let tr;
  while ((tr = trRe.exec(m[1])) !== null) {
    const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    if (tds.length < 4) continue;
    const name = stripTags(tds[0]).replace(/^☆/, "").trim();
    const result = stripTags(tds[1]);
    const flag = stripTags(tds[2]);
    const rawRef = stripTags(tds[3]);
    const rnum = parseFloat(result);
    const [lo, hi] = splitRef(rawRef, flag, Number.isNaN(rnum) ? null : rnum);
    const refText = lo && hi ? `${fmtNum(lo)}~${fmtNum(hi)}` : rawRef || "";
    items.push({ name, result, flag, ref_lo: lo, ref_hi: hi, ref_text: refText });
  }
  return items;
}

export function parseUsList(page) {
  const m = /<table class="zebra">([\s\S]*?)<\/table>/.exec(page);
  if (!m) return [];
  const blocks = m[1].split(/(?=<tr>\s*<td>姓名)/);
  const out = [];
  for (const b of blocks) {
    if (!b.includes("报告时间")) continue;
    const kv = cellsKv(b);
    const rt = kv["报告时间"] || "";
    if (!rt) continue;
    const findings = (kv["超声所见"] || "").trim();
    const conclusion = (kv["超声结论"] || "").trim();
    out.push({
      uid: "", // 由调用方填（hash）
      report_time: rt,
      dept: kv["科室"] || "",
      doctor: kv["医生"] || "",
      findings,
      conclusion,
    });
  }
  return out;
}

async function md5Hex(text) {
  const buf = await crypto.subtle.digest("MD5", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- 抓取入口 ---------- */
export async function scrapeAll(base, pid) {
  const b = base.endsWith("/") ? base : base + "/";
  const labPage = await fetchText(b + "Jianyanlist.asp", { pid });
  const labList = parseLabList(labPage);
  const usPage = await fetchText(b + "Bbaogaolist_zy.asp", { username: pid });
  const usList = parseUsList(usPage);
  for (const u of usList) {
    u.uid = "US" + (await md5Hex(u.report_time + u.findings)).slice(0, 10);
  }
  // 页面含详情链接但解析为 0 → 医院页面结构可能已变化（解析规则失效预警）
  const structureSuspect = labPage.includes("bh.asp?id=") && labList.length === 0;
  return { labList, usList, structureSuspect };
}

export async function scrapeLabDetail(base, id) {
  const b = base.endsWith("/") ? base : base + "/";
  const page = await fetchText(b + "bh.asp?id=" + encodeURIComponent(id));
  return parseLabDetail(page);
}
