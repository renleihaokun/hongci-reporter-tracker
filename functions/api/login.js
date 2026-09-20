/** /api/login — 密码登录与登出
 *  POST {password}  校验 ACCESS_PASSWORD，成功则下发 HttpOnly Cookie（30 天）
 *  DELETE           清除 Cookie（登出） */

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const expected = env.ACCESS_PASSWORD;
  if (!expected) return Response.json({ ok: true, enabled: false });
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* ignore */
  }
  if ((body.password || "") !== expected) {
    return Response.json({ ok: false, error: "密码不正确" }, { status: 401 });
  }
  const token = await sha256Hex(expected);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `hc_auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`,
    },
  });
}

export async function onRequestDelete() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": "hc_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    },
  });
}
