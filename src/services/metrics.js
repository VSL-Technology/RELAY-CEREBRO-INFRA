// src/services/metrics.js
// Very small in-memory metrics for observability

const counters = new Map();

export function inc(key, n = 1) {
  counters.set(key, (counters.get(key) || 0) + n);
}

export function getMetric(key) {
  return counters.get(key) || 0;
}

export function snapshot() {
  const obj = {};
  for (const [k, v] of counters.entries()) obj[k] = v;
  return obj;
}

// Render Prometheus exposition format for a snapshot.
// It emits simple counter metrics named relay_<sanitized_key> with help lines.
export function renderPrometheus() {
  const snap = snapshot();
  const lines = [];
  lines.push('# HELP relay_metrics Simple in-memory relay metrics');
  lines.push('# TYPE relay_metrics gauge');

  for (const [k, v] of Object.entries(snap)) {
    // sanitize key: replace non-alnum with _ and collapse underscores
    const name = `relay_${k}`.replace(/[^a-zA-Z0-9_]/g, '_').replace(/__+/g, '_');
    lines.push(`${name} ${Number(v || 0)}`);
  }

  return lines.join('\n') + '\n';
}

export default { inc, getMetric, snapshot };
