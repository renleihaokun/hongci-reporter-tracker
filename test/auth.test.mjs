// 访问控制测试：middleware 拦截逻辑 + login 接口
import { onRequest as middleware } from "../functions/_middleware.js";
import { onRequestPost, onRequestDelete } from "../functions/api/login.js";

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "ok: " : "FAIL: ") + msg); if (!cond) fail++; };

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const PWD = "test-secret-123";
const token = await sha256Hex(PWD);
const env = { ACCESS_PASSWORD: PWD };
const next = async () => new Response("PASSED-THROUGH", { status: 200 });
const req = (path, cookie) =>
  new Request("https://demo.pages.dev" + path, cookie ? { headers: { Cookie: cookie } } : {});

// 1) 未配置密码：全站开放
{
  const r = await middleware({ env: {}, request: req("/"), next });
  check(r.status === 200 && (await r.text()) === "PASSED-THROUGH", "未配置密码时开放访问");
}

// 2) 配置了密码：无 Cookie 访问页面 -> 401 登录页
{
  const r = await middleware({ env, request: req("/"), next });
  const t = await r.text();
  check(r.status === 401 && t.includes("请输入访问密码"), "无Cookie访问页面返回登录页");
}

// 3) 无 Cookie 访问 API -> 401 JSON
{
  const r = await middleware({ env, request: req("/api/data"), next });
  const j = await r.json();
  check(r.status === 401 && j.ok === false, "无Cookie访问API返回401 JSON");
}

// 4) /api/login 本身放行
{
  const r = await middleware({ env, request: req("/api/login"), next });
  check((await r.text()) === "PASSED-THROUGH", "登录接口不被拦截");
}

// 5) 正确 Cookie 放行
{
  const r = await middleware({ env, request: req("/", `hc_auth=${token}`), next });
  check((await r.text()) === "PASSED-THROUGH", "正确Cookie放行");
}

// 6) 错误 Cookie 拦截
{
  const r = await middleware({ env, request: req("/", "hc_auth=" + "0".repeat(64)), next });
  check(r.status === 401, "错误Cookie拦截");
}

// 7) 登录成功下发 Cookie
{
  const r = await onRequestPost({
    env,
    request: new Request("https://demo.pages.dev/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PWD }),
    }),
  });
  const sc = r.headers.get("Set-Cookie") || "";
  check(r.status === 200 && sc.includes(`hc_auth=${token}`) && sc.includes("HttpOnly"), "登录成功下发HttpOnly Cookie");
}

// 8) 密码错误 401
{
  const r = await onRequestPost({
    env,
    request: new Request("https://demo.pages.dev/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    }),
  });
  check(r.status === 401, "密码错误返回401");
}

// 9) 登出清除 Cookie
{
  const r = await onRequestDelete();
  check((r.headers.get("Set-Cookie") || "").includes("Max-Age=0"), "登出清除Cookie");
}

console.log(fail === 0 ? "\n访问控制测试全部通过 ✔" : `\n${fail} 项失败 ✘`);
process.exit(fail ? 1 : 0);
