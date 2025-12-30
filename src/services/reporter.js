// src/services/reporter.js
// Placeholder reporter: logs structured result and can be extended to POST to backend

export async function reportResult(payload) {
  // For now, just log
  console.log("[reporter] report", JSON.stringify(payload));
  // If BACKEND_REPORT_URL is set, try to POST (best-effort)
  const url = process.env.BACKEND_REPORT_URL;
  if (!url) return { ok: true };

  try {
    // dynamic import to avoid hard dependency
    const fetchMod = await import("node-fetch");
    const fetch = fetchMod.default || fetchMod;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeout: 5000
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    console.error("[reporter] failed to report", e.message);
    return { ok: false, error: e.message };
  }
}

export default { reportResult };
