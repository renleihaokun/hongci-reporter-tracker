/**
 * 统一的重试 / 指数退避工具。
 *
 * 背景：医院查询系统（wx.hcxyb.cn:88）挂在公网上，家属多在院内 WiFi 或手机流量下点刷新，
 * 连接被掐、读流超时、502/504 都很常见。以前任何一次抖动都会让整份报告明细、甚至整轮刷新直接失败，
 * 只能靠人再点一次按钮。这里把"临时性失败自动重试"做成一层薄封装，抓取侧统一复用。
 *
 * 设计要点：
 * - 只重试临时性失败：网络异常、单次尝试超时（TimeoutError）、HTTP 408/425/429/5xx。
 *   其余 4xx 说明请求本身有问题（路径错了、被拒），重试没有意义，立刻抛出。
 * - 指数退避：delay = min(maxDelayMs, baseDelayMs * factor^(尝试序号-1))，再乘 1±jitter 抖动。
 *   抖动是必要的——一次抖动往往让同一轮里多份报告一起失败，若同时重试会在医院那头形成脉冲。
 * - 429/503 带 Retry-After 时按响应头退避，但同样夹在 maxDelayMs 内，避免被一个 60s 的响应头拖死。
 * - 单次尝试超时由调用方（scraper.js fetchText）通过 AbortSignal 传入；sleep/random 可注入，
 *   测试里把真实等待换成"记录 + 立即返回"，不拖慢测试。
 */

export const RETRY_DEFAULTS = Object.freeze({
  attempts: 3, // 总尝试次数 = 1 次首发 + 2 次重试
  baseDelayMs: 500,
  factor: 2, // 500ms → 1s（→ 2s…，受 maxDelayMs 夹取）
  maxDelayMs: 4000,
  jitter: 0.25, // ±25%
});

/** 该 HTTP 状态码是否值得重试（408 超时 / 425 过早 / 429 限流 / 5xx 服务端故障） */
export function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Retry-After 头（秒数或 HTTP 日期）→ 毫秒；无法解析返回 null */
export function parseRetryAfter(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - Date.now());
}

/** HTTP 非 2xx：带 status 与可重试标记，交给 withRetry 判定 */
export class HttpError extends Error {
  constructor(status, url, retryAfterMs = null) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.retryable = isRetryableStatus(status);
  }
}

/**
 * 错误是否值得重试。
 * - 显式标记 retryable 的按标记走（HttpError / 我们自己的超时错误）
 * - TimeoutError：单次尝试超时 → 重试
 * - AbortError：外部取消（平台掐断请求等）→ 不重试，重试也只是白等
 * - 其余（fetch 抛出的 TypeError: fetch failed、连接重置等网络异常）→ 重试
 */
export function isRetryableError(err) {
  if (!err) return false;
  if (err.retryable === true) return true;
  if (err.retryable === false) return false;
  if (err.name === "TimeoutError") return true;
  if (err.name === "AbortError") return false;
  return true;
}

/** 第 attempt 次尝试失败后，下次重试前等多久（attempt 从 1 起） */
export function backoffDelayMs(attempt, opts = {}) {
  const o = { ...RETRY_DEFAULTS, ...opts };
  if (o.retryAfterMs !== null && o.retryAfterMs !== undefined) {
    // 服务端说"稍后再来"就听它的，但给个下限（Retry-After: 0 不该变成连打）也压个上限
    return Math.min(o.maxDelayMs, Math.max(200, o.retryAfterMs));
  }
  const raw = Math.min(o.maxDelayMs, o.baseDelayMs * o.factor ** Math.max(0, attempt - 1));
  if (!o.jitter) return Math.round(raw);
  const r = typeof o.random === "function" ? o.random() : Math.random();
  // 抖动后再夹一次上限，保证"退避上限"是真实上限（否则最多会到 1.25 倍）
  return Math.max(0, Math.min(o.maxDelayMs, Math.round(raw * (1 - o.jitter + 2 * o.jitter * r))));
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 带指数退避重试地执行 fn(attempt)。
 * 全部尝试都失败时抛出最后一次的错误（保留原始错误信息，便于日志定位）。
 *
 * @param {(attempt:number) => Promise<any>} fn
 * @param {object} [opts] attempts/baseDelayMs/factor/maxDelayMs/jitter/random/sleep/isRetryable/onRetry
 */
export async function withRetry(fn, opts = {}) {
  const o = { ...RETRY_DEFAULTS, ...opts };
  const sleep = typeof o.sleep === "function" ? o.sleep : realSleep;
  const attempts = Math.max(1, Math.floor(o.attempts) || 1);
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const retryable = typeof o.isRetryable === "function" ? o.isRetryable(err) : isRetryableError(err);
      if (!retryable || attempt >= attempts) throw err;
      const delayMs = backoffDelayMs(attempt, { ...o, retryAfterMs: err?.retryAfterMs ?? null });
      if (typeof o.onRetry === "function") o.onRetry({ attempt, attempts, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}
