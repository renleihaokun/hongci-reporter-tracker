/**
 * 医院查询页抓取与解析（苏大附一院弘慈血液病医院查询系统）
 * 站点为 Classic ASP + GBK 编码，查询无需鉴权（住院号即凭证），无需会话 Cookie。
 */

import { withRetry, isRetryableError, HttpError, parseRetryAfter } from "./retry.js";

export const DEFAULT_BASE = "http://wx.hcxyb.cn:88/";

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 " +
  "MicroMessenger/8.0.47 NetType/WIFI Language/zh_CN";

/* 单次尝试超时：医院正常 1~3 秒返回；12 秒还没回基本是连接断了。
   没有超时的话，一次"卡住的连接"会把整个刷新请求拖到平台超时——这正是"自动重试"失效的常见原因。 */
export const FETCH_TIMEOUT_MS = 12000;

/** 单次尝试的超时信号：优先 AbortSignal.timeout，退化用 AbortController + setTimeout */
function timeoutSignal(ms) {
  if (!ms || ms <= 0) return { signal: undefined, timedOut: () => false, cancel: () => {} };
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    // 这个 signal 只会因为超时而 abort，所以 aborted 就是"超时了"
    const signal = AbortSignal.timeout(ms);
    return { signal, timedOut: () => signal.aborted, cancel: () => {} };
  }
  let fired = false;
  const ac = new AbortController();
  const t = setTimeout(() => { fired = true; ac.abort(); }, ms);
  return { signal: ac.signal, timedOut: () => fired, cancel: () => clearTimeout(t) };
}

/** 单次抓取：返回 GBK 解码后的文本；HTTP 非 2xx 抛 HttpError（带 retryable 标记） */
async function fetchOnce(url, params, timeoutMs) {
  const init = { headers: { "User-Agent": UA } };
  if (params) {
    init.method = "POST";
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(params).toString();
  }
  const timer = timeoutSignal(timeoutMs);
  if (timer.signal) init.signal = timer.signal;
  try {
    const resp = await fetch(url, init);
    if (!resp.ok) {
      if (resp.body) { try { await resp.body.cancel(); } catch {} } // 不读的响应体显式放掉，别占着连接
      throw new HttpError(resp.status, url, parseRetryAfter(resp.headers?.get?.("Retry-After")));
    }
    const buf = await resp.arrayBuffer(); // 读流中途断掉也会在 withRetry 里重试
    return new TextDecoder("gb18030").decode(buf);
  } catch (e) {
    if (timer.timedOut()) {
      const err = new Error(`请求超时（超过 ${timeoutMs}ms，医院网络可能不通）`);
      err.name = "TimeoutError";
      err.retryable = true;
      throw err;
    }
    throw e;
  } finally {
    timer.cancel();
  }
}

/**
 * 带指数退避重试的抓取（医院网络抖动是常态，一次抖动不该让整轮刷新失败）。
 * 默认 3 次尝试：500ms → 1s（±25% 抖动）；可重试 408/425/429/5xx、连接异常、单次尝试超时。
 * opts 可覆盖 attempts/baseDelayMs/factor/maxDelayMs/jitter/sleep/isRetryable/onRetry 与 timeoutMs。
 * opts.deadline（绝对时间戳）用于整轮预算：过了这个点就不再重试，避免一轮被拖成好几分钟。
 */
export async function fetchText(url, params, opts = {}) {
  const deadline = Number.isFinite(opts.deadline) ? opts.deadline : 0;
  const userIsRetryable = opts.isRetryable;
  return withRetry(() => fetchOnce(url, params, opts.timeoutMs ?? FETCH_TIMEOUT_MS), {
    ...opts,
    isRetryable: (err) => {
      if (deadline && Date.now() >= deadline) return false; // 整轮预算用完：这次失败就此打住
      return typeof userIsRetryable === "function" ? userIsRetryable(err) : isRetryableError(err);
    },
    onRetry: ({ attempt, attempts, delayMs, error }) => {
      // 日志里不带 query（详情 URL 含报告 ID）：排障够用，又不把标识写进日志
      console.warn(
        `[scraper] ${url.split("?")[0]} 第 ${attempt}/${attempts} 次失败：${error?.message || error}；${Math.round(delayMs)}ms 后重试`
      );
      if (typeof opts.onRetry === "function") opts.onRetry({ attempt, attempts, delayMs, error });
    },
  });
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

/* 医院网页端"没有明细"的占位页：详情页只回一句
   「该记录如果未查询,可以到楼层自助机器查询！」（见微生物培养及鉴定等报告）。
   这与"网络抖动/解析失败"是两回事——前者重试一万次也是空的，必须单独识别，
   否则刷新会无限重试、永不归档。 */
export const NO_DETAIL_MARK = /该记录如果未查询/;

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

/* ---------- 抓取入口 ----------
 * opts 会透传给 fetchText（重试次数、退避参数、timeoutMs、sleep 等），测试里用它把等待压缩掉。 */
export async function scrapeAll(base, pid, opts = {}) {
  const b = base.endsWith("/") ? base : base + "/";
  const labPage = await fetchText(b + "Jianyanlist.asp", { pid }, opts);
  const labList = parseLabList(labPage);
  const usPage = await fetchText(b + "Bbaogaolist_zy.asp", { username: pid }, opts);
  const usList = parseUsList(usPage);
  for (const u of usList) {
    u.uid = "US" + (await md5Hex(u.report_time + u.findings)).slice(0, 10);
  }
  // 页面含详情链接但解析为 0 → 医院页面结构可能已变化（解析规则失效预警）
  const structureSuspect = labPage.includes("bh.asp?id=") && labList.length === 0;
  return { labList, usList, structureSuspect };
}

/**
 * 抓取单份检验报告明细。
 * 返回 { items, noDetail }：
 *   - items 非空            → 正常解析
 *   - items 为空 & noDetail → 医院网页端本就不提供明细（占位页），属"已知无数据"，不该重试
 *   - items 为空 & !noDetail→ 页面拿到但没解析出内容（结构变化/临时故障），回调方应重试
 * 说明：连接层面的临时故障（超时/5xx/读流中断）已在 fetchText 内部退避重试过了，
 * 能走到这里的都是"真的拿到了页面"，所以上面这条判断是准的。
 */
export async function scrapeLabDetail(base, id, opts = {}) {
  const b = base.endsWith("/") ? base : base + "/";
  const page = await fetchText(b + "bh.asp?id=" + encodeURIComponent(id), null, opts);
  const items = parseLabDetail(page);
  return { items, noDetail: items.length === 0 && NO_DETAIL_MARK.test(page) };
}
