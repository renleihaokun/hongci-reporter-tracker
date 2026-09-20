/**
 * 全站访问控制（Pages Middleware）
 * - 配置环境变量 ACCESS_PASSWORD 后，所有页面/API 均需登录；未配置则完全开放
 * - 登录后下发 HttpOnly Cookie（hc_auth = sha256(密码)），30 天有效
 */

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>请输入访问密码</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f4f6f8;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#fff;border-radius:16px;padding:32px 24px;max-width:380px;width:100%;
box-shadow:0 4px 20px rgba(0,0,0,.08);text-align:center}
h1{font-size:20px;margin-bottom:6px}
.sub{color:#777;font-size:13px;margin-bottom:22px}
input{width:100%;padding:14px;border:1.5px solid #ddd;border-radius:10px;font-size:16px;
margin-bottom:14px;outline:none;-webkit-appearance:none}
input:focus{border-color:#1976d2}
button{width:100%;padding:14px;border:none;border-radius:10px;background:#1976d2;color:#fff;
font-size:16px;font-weight:600;cursor:pointer}
button[disabled]{opacity:.6}
.err{color:#d32f2f;font-size:13px;margin-top:10px;min-height:18px}
</style>
</head>
<body>
<div class="card">
<h1>🔒 住院报告追踪</h1>
<div class="sub">这是家人专属的页面，请输入访问密码</div>
<form id="f">
<input type="password" id="pwd" placeholder="访问密码" autocomplete="current-password" autofocus>
<button type="submit" id="btn">进入</button>
</form>
<div class="err" id="err"></div>
</div>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("btn");
  const err = document.getElementById("err");
  btn.disabled = true; btn.textContent = "验证中…"; err.textContent = "";
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: document.getElementById("pwd").value }),
    });
    const j = await r.json();
    if (j.ok) { location.reload(); return; }
    err.textContent = j.error || "密码不正确";
  } catch (e2) { err.textContent = "网络错误，请重试"; }
  btn.disabled = false; btn.textContent = "进入";
});
</script>
</body>
</html>`;

export async function onRequest(context) {
  const { env, request } = context;
  const password = env.ACCESS_PASSWORD;
  if (!password) return context.next(); // 未配置密码：开放访问

  const url = new URL(request.url);
  if (url.pathname === "/api/login") return context.next(); // 登录/登出接口放行

  const cookie = request.headers.get("Cookie") || "";
  const m = /(?:^|;\s*)hc_auth=([a-f0-9]{64})/.exec(cookie);
  if (m && m[1] === (await sha256Hex(password))) return context.next();

  if (url.pathname.startsWith("/api/")) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return new Response(LOGIN_HTML, {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
