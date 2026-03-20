import { isIP } from "net";

export function isValidIp(ip) {
  if (!ip || typeof ip !== "string") return false;
  return isIP(ip.trim()) !== 0;
}

export function isValidMac(mac) {
  if (!mac || typeof mac !== "string") return false;
  return /^([0-9a-fA-F]{2}[:\-]){5}[0-9a-fA-F]{2}$/i.test(mac.trim());
}

export function normalizeMac(mac) {
  return String(mac || "").trim().toUpperCase().replace(/-/g, ":");
}

export function normalizeIp(ip) {
  const value = String(ip || "").trim();
  return isValidIp(value) ? value : null;
}

export function normalizeMacAddress(mac) {
  return isValidMac(mac) ? normalizeMac(mac) : null;
}

