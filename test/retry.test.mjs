// 重试 / 指数退避测试：医院网络抖动（连接异常、超时、5xx、响应体截断）必须自动重试，且退避要是指数级
import {
  withRetry, backoffDelayMs, parseRetryAfter, isRetryableStatus, isRetryableError, HttpError, RETRY_DEFAULTS,
} from "../functions/_lib/retry.js";
import { scrapeLabDetail, fetchText } from "../functions/_lib/scraper.js";

let fail = 0;
const eq = (a, b, msg) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  if (!good) { fail++; console.log("FAIL:", msg, "\n  got:", JSON.stringify(a), "\n  exp:", JSON.stringify(b)); }
  else console.log("ok:", msg);
};
const ok = (cond, msg) => eq(Boolean(cond), true, msg);

const noJitter = { random: () => 0.5 }; // 抖动因子取中值 → 退避曲线可精确断言

/* ---------- 1) 退避曲线：指数增长 + 上限 + 抖动 ---------- */
eq(RETRY_DEFAULTS.attempts, 3, "默认 3 次尝试（1 首发 + 2 重试）");
eq(backoffDelayMs(1, noJitter), 500, "第 1 次失败后等 500ms");
eq(backoffDelayMs(2, noJitter), 1000, "第 2 次失败后等 1s（指数）");
eq(backoffDelayMs(3, noJitter), 2000, "第 3 次失败后等 2s（指数）");
eq(backoffDelayMs(6, noJitter), 4000, "退避不超过上限 4s");
eq(backoffDelayMs(6, { random: () => 1 }), 4000, "抖动后仍夹在上限内（不会跑到 1.25 倍）");
eq(backoffDelayMs(1, { random: () => 0 }), 375, "抖动下限 -25%");
eq(backoffDelayMs(1, { random: () => 1 }), 625, "抖动上限 +25%");
eq(backoffDelayMs(1, { retryAfterMs: 0, random: () => 0.5 }), 200, "Retry-After: 0 有 200ms 下限（不许连打）");
{
  const a = backoffDelayMs(2, { random: () => 0.5 });
  const b = backoffDelayMs(2, { random: () => 0.5 });
  eq(a === b, true, "同参数退避可复现（random 注入）");
  ok(backoffDelayMs(2) >= 750 && backoffDelayMs(2) <= 1250, "未注入 random 时仍在 ±25% 区间内");
}
eq(backoffDelayMs(1, { retryAfterMs: 3000, random: () => 0.5 }), 3000, "Retry-After 优先于指数退避");
eq(backoffDelayMs(1, { retryAfterMs: 60000, random: () => 0.5 }), 4000, "Retry-After 也被上限夹取（防被拖死）");

/* ---------- 2) Retry-After 与错误分类 ---------- */
eq(parseRetryAfter("2"), 2000, "Retry-After 秒数");
eq(parseRetryAfter(""), null, "空 Retry-After 视为无");
eq(parseRetryAfter("bogus"), null, "非法 Retry-After 视为无");
ok(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT") !== null, "Retry-After HTTP 日期可解析");

eq([408, 425, 429, 500, 502, 503, 504].every(isRetryableStatus), true, "408/425/429/5xx 可重试");
eq([400, 401, 403, 404].some(isRetryableStatus), false, "普通 4xx 不重试");
eq(isRetryableError(new HttpError(503, "u")), true, "HttpError 503 可重试");
eq(isRetryableError(new HttpError(404, "u")), false, "HttpError 404 不可重试");
eq(isRetryableError(Object.assign(new Error("超时"), { name: "TimeoutError" })), true, "单次尝试超时可重试");
eq(isRetryableError(Object.assign(new Error("取消"), { name: "AbortError" })), false, "外部取消不重试");
eq(isRetryableError(new TypeError("fetch failed")), true, "网络异常（fetch failed）可重试");

/* ---------- 3) withRetry 行为 ---------- */
{
  const sleeps = [];
  let calls = 0;
  const out = await withRetry(
    async () => { calls++; if (calls < 3) throw new TypeError("fetch failed"); return "ok"; },
    { sleep: async (ms) => sleeps.push(ms), random: () => 0.5 }
  );
  eq([out, calls], ["ok", 3], "抖动两次后第 3 次成功");
  eq(sleeps, [500, 1000], "实际等待序列 500ms → 1s（指数退避）");
}
{
  let calls = 0;
  const retries = [];
  let err = null;
  try {
    await withRetry(
      async () => { calls++; throw new TypeError("fetch failed"); },
      { attempts: 3, sleep: async () => {}, random: () => 0.5, onRetry: (i) => retries.push([i.attempt, i.attempts, i.delayMs]) }
    );
  } catch (e) { err = e; }
  eq(calls, 3, "重试用尽后放弃");
  eq(err && err.message, "fetch failed", "抛出最后一次的原始错误（不吞掉原因）");
  eq(retries, [[1, 3, 500], [2, 3, 1000]], "onRetry 汇报尝试序号与本次退避时长");
}
{
  let calls = 0;
  let err = null;
  try {
    await withRetry(async () => { calls++; throw new HttpError(404, "u"); }, { attempts: 4, sleep: async () => {} });
  } catch (e) { err = e; }
  eq([calls, err && err.status], [1, 404], "确定性失败（404）不浪费重试");
}
{
  let slept = 0;
  const v = await withRetry(async () => 42, { sleep: async () => { slept++; } });
  eq([v, slept], [42, 0], "首次成功不等待");
}

/* ---------- 4) 抓取层集成：stub 全局 fetch，验证真的会自动重试 ---------- */
const ASCII_DETAIL = '<table class="zebra"><tr><td>WBC</td><td>5.32</td><td></td><td>4.0010.00</td></tr></table>';
const hdr = (h = {}) => ({ get: (k) => (k in h ? h[k] : null) });
const pageRes = (text) => ({ ok: true, status: 200, headers: hdr(), arrayBuffer: async () => new TextEncoder().encode(text).buffer });
const fastRetry = { sleep: async () => {}, random: () => 0.5 };

{
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  console.warn = () => {}; // 重试日志在测试输出里是噪音
  try {
    // 4.1 连接抖动两次后成功（这是"医院网烂"最常见的形态）
    {
      const calls = [];
      globalThis.fetch = async (url) => {
        calls.push(String(url));
        if (calls.length < 3) throw new TypeError("fetch failed");
        return pageRes(ASCII_DETAIL);
      };
      const { items, noDetail } = await scrapeLabDetail("http://h/", "ABC123", fastRetry);
      eq(calls.length, 3, "连接抖动两次 → 共抓 3 次");
      eq(calls[0], "http://h/bh.asp?id=ABC123", "详情请求 URL 正确");
      eq([items.length, noDetail], [1, false], "重试后正常解析出明细");
      eq([items[0].name, items[0].ref_text], ["WBC", "4~10"], "解析结果正确（参考范围已拆分）");
    }
    // 4.2 502/503 服务端故障也重试；Retry-After 生效（用 3 秒，与指数退避的 1 秒区分开）
    {
      let n = 0;
      const sleeps = [];
      const seen = [];
      globalThis.fetch = async () => {
        n++;
        if (n === 1) return { ok: false, status: 503, headers: hdr({ "Retry-After": "3" }) };
        if (n === 2) return { ok: false, status: 502, headers: hdr() };
        return pageRes(ASCII_DETAIL);
      };
      const text = await fetchText("http://h/x.asp", null, {
        attempts: 3, random: () => 0.5, onRetry: (i) => { sleeps.push(i.delayMs); seen.push(i.attempt); },
        sleep: async () => {},
      });
      eq(n, 3, "503/502 → 重试到成功");
      eq(sleeps, [3000, 1000], "第 1 次听 Retry-After: 3，第 2 次回到指数退避 1s");
      eq(seen, [1, 2], "onRetry 按顺序汇报");
      ok(text.includes("WBC"), "最终返回解码后的页面文本");
    }
    // 4.2b 整轮预算（deadline）用完：不再追加重试，直接把失败交出去
    {
      let n = 0;
      let err = null;
      globalThis.fetch = async () => { n++; throw new TypeError("fetch failed"); };
      try {
        await fetchText("http://h/budget.asp", null, { attempts: 3, sleep: async () => {}, deadline: Date.now() - 1 });
      } catch (e) { err = e; }
      eq([n, err && err.message], [1, "fetch failed"], "过了 deadline 只试 1 次（不把整轮拖长）");
    }
    // 4.3 404 不重试（路径/参数问题，重试无意义）
    {
      let n = 0;
      let err = null;
      globalThis.fetch = async () => { n++; return { ok: false, status: 404, headers: hdr() }; };
      try { await fetchText("http://h/missing.asp", null, fastRetry); } catch (e) { err = e; }
      eq([n, err && err.status], [1, 404], "404 只请求 1 次并抛出");
    }
    // 4.4 响应体读了一半断掉（移动网络常见）→ 重试
    {
      let n = 0;
      globalThis.fetch = async () => {
        n++;
        if (n === 1) return { ok: true, status: 200, headers: hdr(), arrayBuffer: async () => { throw new TypeError("terminated"); } };
        return pageRes(ASCII_DETAIL);
      };
      const text = await fetchText("http://h/y.asp", null, fastRetry);
      eq(n, 2, "读流中断 → 重试 1 次");
      ok(text.includes("WBC"), "重试后拿到完整页面");
    }
    // 4.5 连接卡住（医院网络典型）：单次尝试超时后重试，不会把整轮刷新拖死
    {
      let n = 0;
      // Node 里 AbortSignal.timeout 的定时器是 unref 的，单靠它撑不住事件循环，测试自己保活
      const keepAlive = setInterval(() => {}, 20);
      try {
        globalThis.fetch = (url, init) => {
          n++;
          return new Promise((_, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason || Object.assign(new Error("aborted"), { name: "AbortError" })));
          });
        };
        let err = null;
        const t0 = Date.now();
        try { await fetchText("http://h/hang.asp", null, { attempts: 2, timeoutMs: 60, sleep: async () => {} }); } catch (e) { err = e; }
        eq(n, 2, "连接卡住 → 超时后重试 1 次");
        eq(err && err.name, "TimeoutError", "超时被识别为可重试错误（而不是永久卡住）");
        ok(Date.now() - t0 < 3000, "超时判定及时（" + (Date.now() - t0) + "ms）");
      } finally {
        clearInterval(keepAlive);
      }
    }
    // 4.5b 老运行时没有 AbortSignal.timeout（降级路径）：同样必须超时并可重试
    {
      let n = 0;
      const keepAlive = setInterval(() => {}, 20);
      const realTimeout = AbortSignal.timeout;
      try {
        AbortSignal.timeout = undefined;
        globalThis.fetch = (url, init) => {
          n++;
          return new Promise((_, reject) => {
            init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          });
        };
        let err = null;
        try { await fetchText("http://h/hang2.asp", null, { attempts: 2, timeoutMs: 60, sleep: async () => {} }); } catch (e) { err = e; }
        eq(n, 2, "降级路径：连接卡住 → 超时后重试 1 次");
        eq([err && err.name, /请求超时/.test(err && err.message)], ["TimeoutError", true], "降级路径的超时被识别为可重试");
      } finally {
        AbortSignal.timeout = realTimeout;
        clearInterval(keepAlive);
      }
    }
    // 4.6 完全不通：3 次尝试后抛出，且尝试次数与退避次数一致
    {
      let n = 0;
      const sleeps = [];
      let err = null;
      globalThis.fetch = async () => { n++; throw new TypeError("fetch failed"); };
      try {
        await fetchText("http://h/down.asp", null, { sleep: async (ms) => sleeps.push(ms), random: () => 0.5, onRetry: () => {} });
      } catch (e) { err = e; }
      eq([n, sleeps], [3, [500, 1000]], "彻底不通：3 次尝试 + 2 次指数退避后放弃");
      eq(err && err.message, "fetch failed", "抛出原始网络错误");
    }
    // 4.7 POST 参数（列表页查询）经过重试后仍然原样发出
    {
      let body = null;
      let n = 0;
      globalThis.fetch = async (url, init) => {
        n++;
        if (n === 1) throw new TypeError("fetch failed");
        body = init.body;
        return pageRes(ASCII_DETAIL);
      };
      await fetchText("http://h/Jianyanlist.asp", { pid: "000000" }, fastRetry);
      eq([n, body], [2, "pid=000000"], "POST 表单参数在重试后仍正确");
    }
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
}

console.log(fail === 0 ? "\n重试测试全部通过 ✔" : `\n${fail} 项失败 ✘`);
process.exit(fail === 0 ? 0 : 1);
