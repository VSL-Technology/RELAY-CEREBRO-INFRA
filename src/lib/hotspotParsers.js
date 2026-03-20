import { normalizeMacAddress } from "./validators.js";

// Uses the more defensive extractor from activeSessionMonitor: it walks nested
// RouterOS result shapes recursively instead of only flattening the first level.
export function extractRows(result) {
  const rows = [];
  const queue = [];

  if (Array.isArray(result)) {
    queue.push(...result);
  } else if (result) {
    if (Array.isArray(result.results)) queue.push(...result.results);
    if (Array.isArray(result.data)) queue.push(...result.data);
    else queue.push(result);
  }

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) continue;

    if (Array.isArray(item)) {
      queue.push(...item);
      continue;
    }

    if (typeof item !== "object") continue;

    if (Array.isArray(item.data)) {
      queue.push(...item.data);
      continue;
    }

    if (item.data && typeof item.data === "object") {
      rows.push(item.data);
      continue;
    }

    rows.push(item);
  }

  return rows;
}

export function parseHotspotEntry(row) {
  if (!row || typeof row !== "object") return null;

  const ip = String(row.address || row["=address"] || "").trim() || null;
  const macRaw = String(row["mac-address"] || row.macAddress || row["=mac-address"] || "").trim();
  const user = String(row.user || row["=user"] || "").trim() || null;
  const uptime = String(row.uptime || row["=uptime"] || "").trim() || null;
  const id = String(row[".id"] || row["=.id"] || row.id || "").trim() || null;
  const type = String(row.type || row["=type"] || "").trim() || null;
  const mac = normalizeMacAddress(macRaw);

  return {
    id,
    ip,
    mac,
    user,
    uptime,
    type,
    raw: row
  };
}

export function normalizeActiveRow(row) {
  const parsed = parseHotspotEntry(row);
  if (!parsed || !parsed.ip) return null;

  return {
    ip: parsed.ip,
    mac: parsed.mac,
    uptime: parsed.uptime,
    user: parsed.user
  };
}

