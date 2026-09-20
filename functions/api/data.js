/** GET /api/data — 返回全部归档数据供前端渲染 */
function parseDt(s) {
  const m = /(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(s || "");
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
}

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const labs = await env.DB.prepare(
      "SELECT id, audit_time, project, reviewer, items_json, created_at FROM lab_reports ORDER BY audit_time DESC"
    ).all();
    const uss = await env.DB.prepare(
      "SELECT uid, report_time, dept, doctor, findings, conclusion, created_at FROM us_reports ORDER BY report_time DESC"
    ).all();
    const meta = await env.DB.prepare("SELECT key, value FROM meta").all();
    const metaMap = {};
    for (const row of meta.results || []) metaMap[row.key] = row.value;

    const labReports = (labs.results || [])
      .map((r) => ({ ...r, items: JSON.parse(r.items_json || "[]"), items_json: undefined }))
      .sort((a, b) => parseDt(b.audit_time) - parseDt(a.audit_time));
    const usReports = (uss.results || [])
      .sort((a, b) => parseDt(b.report_time) - parseDt(a.report_time));

    return Response.json({
      ok: true,
      patient: JSON.parse(metaMap.patient_json || "{}"),
      last_refresh: metaMap.last_refresh || null,
      ai_enabled: Boolean(env.LLM_BASE_URL && env.LLM_API_KEY),
      auth_required: Boolean(env.ACCESS_PASSWORD),
      lab_reports: labReports,
      us_reports: usReports,
    });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
