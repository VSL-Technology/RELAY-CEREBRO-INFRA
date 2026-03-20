import "./bootstrap/env.js";

// src/index.js
import crypto, { randomUUID } from "crypto";
import express from "express";
import morgan from "morgan";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import {
  authorizeByPedido,
  resyncDevice,
  revokeBySession
} from "./services/authorize.js";
import { executeAction } from "./services/actionHandler.js";
import { registerOrUpdateDevice } from "./services/deviceRegistry.js";
import { registerDevice } from "./registry/deviceRegistry.js";
import EventConsumer from "./services/eventConsumer.js";
import jobRunner from "./services/jobRunner.js";
import { renderPrometheus } from "./services/metrics.js";
import jobStore from "./services/jobStore.js";
import logger from "./services/logger.js";
import relayManager from "./services/relayManager.js";
import { RelayError } from "./services/errors.js";
import wgManager from './services/wireguardManager.js';
import wireguardStatus from './services/wireguardStatus.js';
import peerBinding from './services/peerBinding.service.js';
import mikrotikProbe from './services/mikrotikProbe.service.js';
import routerRegistry from './routes/routerRegistry.js';
import sessionRoutes from "./routes/sessionRoutes.js";
import pagarmeWebhookRoutes from "./routes/pagarmeWebhook.js";
import reconciler from './services/reconciler.js';
import { runMikrotikCommands } from "./services/mikrotik.js";
import { getMikById } from "./config/mikrotiks.js";
import identityService from './services/identityService.js';
import identityStore from './services/identityStore.js';
import routerHealth from './services/routerHealth.js';
import audit from './services/audit.js';
import sessionStore from "./services/sessionStore.js";
import hotspotManager from "./services/hotspotManager.js";
import sessionCleaner from "./services/sessionCleaner.js";
import activeSessionMonitor from "./services/activeSessionMonitor.js";
import { JOB_RUNNER_ENABLED } from "./config/controlPlane.js";
import { getPrisma } from "./lib/prisma.js";
import redis, { assertRedisReady } from "./lib/redis.js";
import { buildSentence } from "./lib/buildSentence.js";
import { ensureDefaultTenant } from "./bootstrap/ensureDefaultTenant.js";
import healthRoute, { healthLiveRoute, healthReadyRoute } from "./routes/healthRoute.js";
import { runWithRequestContext } from "./lib/requestContext.js";
import { register, activeSessions } from "./lib/metrics.js";
import {
  isValidIp,
  isValidMac,
  normalizeIp,
  normalizeMac,
  normalizeMacAddress
} from "./lib/validators.js";

const RELAY_API_SECRET = process.env.RELAY_API_SECRET || null;
if (!RELAY_API_SECRET) {
  throw new Error("RELAY_API_SECRET missing");
}

// basic rate limiter (express-rate-limit)
const rateWindowMs = Number(process.env.RELAY_RATE_WINDOW_MS || 60000);
const rateLimitMax = Number(process.env.RATE_LIMIT_PER_ROUTER || process.env.RELAY_RATE_LIMIT || 60);
function extractRouterRateLimitKey(req) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const query = req.query && typeof req.query === "object" ? req.query : {};
  const headerRouterId = req.headers["x-router-id"];
  const routerId = [
    body.routerId,
    body.mikId,
    body.router,
    query.routerId,
    query.mikId,
    query.router,
    headerRouterId
  ]
    .map((value) => String(value || "").trim())
    .find(Boolean);

  if (routerId) return `router:${routerId}`;
  return `ip:${ipKeyGenerator(req.ip || "")}`;
}

const limiter = rateLimit({
  windowMs: rateWindowMs,
  max: rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => extractRouterRateLimitKey(req),
});

const app = express();
const PORT = process.env.PORT || 3000;
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const isStrictSecurity =
  process.env.RELAY_STRICT_SECURITY === "1" ||
  process.env.RELAY_STRICT_SECURITY === "true";
const MAX_REDIRECT_HTML_BYTES = 16 * 1024;
const DEFAULT_REDIRECT_PATH = "hotspot4/redirect.html";
const DEFAULT_HOTSPOT_PROFILE = process.env.RELAY_DEFAULT_HOTSPOT_PROFILE || "hsprof1";
const REDIS_REQUIRED = String(process.env.REDIS_REQUIRED || "false") === "true";

if (!RELAY_TOKEN) {
  logger.error("missing token configuration: set RELAY_TOKEN");
  process.exit(1);
}

function extractRelayToken(req) {
  const authHeader = typeof req.headers.authorization === "string"
    ? req.headers.authorization.trim()
    : "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.replace("Bearer ", "");
  }

  return null;
}

const RETRY_NOW_COOLDOWN_MS = Number(process.env.RELAY_RETRY_NOW_COOLDOWN_MS || 30000);
const SESSION_PUBLIC =
  process.env.SESSION_PUBLIC === "1" ||
  process.env.SESSION_PUBLIC === "true";
const lastRetryNowBySid = new Map();
if (isStrictSecurity) {
  if (!process.env.RELAY_API_SECRET) {
    logger.error('missing RELAY_API_SECRET while RELAY_STRICT_SECURITY enabled');
    process.exit(1);
  }
  if (!process.env.RELAY_TOKEN) {
    logger.error('missing RELAY_TOKEN while RELAY_STRICT_SECURITY enabled');
    process.exit(1);
  }
}

function normalizeClientIp(ip) {
  const raw = String(ip || "").trim();
  if (raw.startsWith("::ffff:")) return raw.slice(7);
  return raw;
}

// HMAC timestamp tolerance — configurable, default 300s (5 min) to tolerate clock skew.
// Replay protection is handled by nonce dedup in Redis (see verifyHmac).
const HMAC_WINDOW_MS = Number(process.env.HMAC_WINDOW_MS || 300000);

async function refreshActiveSessionMetrics() {
  activeSessions.reset();

  const sessions = await sessionStore.listSessions();
  const counts = new Map();

  for (const session of sessions) {
    if (!session || session.status !== "authorized") continue;

    const routerId =
      String(session.router || session.identity || "").trim() || "unknown";
    counts.set(routerId, (counts.get(routerId) || 0) + 1);
  }

  for (const [routerId, total] of counts.entries()) {
    activeSessions.set({ router_id: routerId }, total);
  }
}

async function verifyHmac(req) {
  // Already verified by an earlier middleware in this request chain — skip
  if (req._hmacVerified) return;

  const secret = process.env.RELAY_API_SECRET;
  if (!secret) {
    throw new Error("HMAC_SECRET_NOT_CONFIGURED");
  }

  const ts = req.headers["x-relay-ts"];
  const nonce = req.headers["x-relay-nonce"];
  const signatureHeader = req.headers["x-relay-signature"];
  const signature = typeof signatureHeader === "string" && signatureHeader.startsWith("v1=")
    ? signatureHeader.slice(3)
    : signatureHeader;

  if (!ts || !nonce || !signature) {
    throw new Error("HMAC_MISSING");
  }

  const now = Date.now();
  if (Math.abs(now - Number(ts)) > HMAC_WINDOW_MS) {
    throw new Error("HMAC_TS_OUT_OF_RANGE");
  }

  const body = req.body ? JSON.stringify(req.body) : "";
  const base = `${req.method}\n${req.path}\n${ts}\n${nonce}\n${body}`;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(base)
    .digest("hex");

  if (!/^[a-f0-9]+$/i.test(String(signature))) {
    throw new Error("HMAC_SIGNATURE_INVALID");
  }

  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(String(signature), "hex");
  if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    throw new Error("HMAC_SIGNATURE_INVALID");
  }

  // Nonce dedup: store nonce in Redis for the duration of HMAC_WINDOW_MS to block replays.
  // Fail-open: if Redis is unavailable, skip dedup and log a warning.
  try {
    const nonceKey = `nonce:${nonce}`;
    const stored = await redis.set(nonceKey, '1', 'PX', HMAC_WINDOW_MS, 'NX');
    if (!stored) {
      throw new Error("HMAC_NONCE_REPLAYED");
    }
  } catch (err) {
    if (err.message === "HMAC_NONCE_REPLAYED") throw err;
    // Redis error — log warning and allow request through (fail-open)
    logger.warn("hmac.nonce_redis_error", { message: err && err.message });
  }

  // Mark request as verified to prevent double-check if middleware is applied twice
  req._hmacVerified = true;
}

async function authMiddleware(req, res, next) {
  const provided = extractRelayToken(req);
  const ip = normalizeClientIp(req.ip);
  if (provided !== RELAY_TOKEN) {
    logger.warn("security.auth.denied", {
      reason: "unauthorized",
      path: req.originalUrl || req.url,
      ip
    });
    return res.status(401).json({ ok: false, code: "UNAUTHORIZED" });
  }

  try {
    await verifyHmac(req);
  } catch (err) {
    logger.warn("security.hmac.denied", {
      path: req.originalUrl || req.url,
      method: req.method,
      ip,
      code: err && err.message ? err.message : "HMAC_INVALID"
    });
    return res.status(401).json({
      ok: false,
      code: err.message
    });
  }

  next();
}

async function validateRelayAuth(req, res, next) {
  if (SESSION_PUBLIC) {
    return next();
  }

  const provided = extractRelayToken(req);
  const ip = normalizeClientIp(req.ip);

  if (provided !== RELAY_TOKEN) {
    logger.warn("session.security.blocked", {
      reason: "unauthorized",
      path: req.originalUrl || req.url,
      ip
    });
    return res.status(401).json({ ok: false, code: "UNAUTHORIZED" });
  }

  try {
    await verifyHmac(req);
  } catch (err) {
    logger.warn("session.security.blocked", {
      reason: err && err.message ? err.message : "HMAC_INVALID",
      path: req.originalUrl || req.url,
      method: req.method,
      ip
    });
    return res.status(401).json({
      ok: false,
      code: err.message
    });
  }

  return next();
}


// Keep morgan for access logs, but keep minimal formatting to avoid double-logging
morgan.token("request-id", (req) => req.requestId || "-");
app.use((req, res, next) => {
  const incomingRequestId = String(req.headers["x-request-id"] || "").trim();
  const reqId = incomingRequestId || randomUUID();
  req.id = reqId;
  req.requestId = reqId;
  res.setHeader("X-Request-ID", reqId);
  runWithRequestContext({ reqId }, () => next());
});
app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" req_id=:request-id'));

// Dedicated webhook route must run before JSON parser to preserve raw stream.
app.use(pagarmeWebhookRoutes);

app.use(express.json({
  limit: "1mb",
  verify: (req, res, buf) => {
    req.rawBody = Buffer.from(buf);
  },
}));

// Global rate limit keyed by routerId when available, falling back to IP.
app.use(limiter);

// Public healthcheck for deploy validation
app.get("/health/live", healthLiveRoute);
app.get("/health/ready", healthReadyRoute);
app.get("/health", healthRoute);
app.get("/health/full", async (req, res) => {
  let redisOk = false;

  try {
    await redis.ping();
    redisOk = true;
  } catch {}

  return res.json({
    ok: true,
    redis: redisOk,
    uptime: process.uptime()
  });
});

// Prometheus metrics scrape endpoint.
app.get("/metrics", async (req, res) => {
  const token = req.headers["x-metrics-token"];
  const expected = process.env.METRICS_TOKEN;

  if (expected) {
    if (token !== expected) {
      return res.status(401).json({ error: "unauthorized" });
    }
  } else {
    const ip = normalizeClientIp(req.ip ?? req.socket?.remoteAddress ?? "");
    const isLocal =
      ip === "127.0.0.1" ||
      ip === "::1" ||
      ip === "::ffff:127.0.0.1";

    if (!isLocal) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  try {
    await refreshActiveSessionMetrics();
  } catch (error) {
    logger.warn("metrics.active_sessions_refresh_error", {
      message: error && error.message ? error.message : String(error)
    });
  }

  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.use("/session", validateRelayAuth);
app.use("/session", sessionRoutes);

app.post("/session/start", async (req, res) => {
  try {
    const body = req.body || {};
    const ip = String(body.ip || "").trim();
    const mac = body.mac === undefined || body.mac === null || body.mac === ""
      ? null
      : String(body.mac).trim();
    const router = typeof body.router === "string" ? body.router.trim() : null;
    const identity = typeof body.identity === "string" ? body.identity.trim() : null;

    if (!ip) {
      return res.status(400).json({
        ok: false,
        code: "invalid_payload",
        message: "ip required"
      });
    }
    if (!isValidIp(ip)) {
      return res.status(400).json({
        ok: false,
        code: "invalid_ip",
        message: "invalid IP format"
      });
    }
    if (mac && !isValidMac(mac)) {
      return res.status(400).json({
        ok: false,
        code: "invalid_mac",
        message: "invalid MAC format"
      });
    }

    const session = await sessionStore.createSession({
      ip: normalizeIp(ip),
      mac: mac ? normalizeMac(mac) : null,
      router,
      identity
    });

    logger.info("session.start", {
      sessionId: session.sessionId,
      ip: session.ip,
      mac: session.mac,
      router: session.router
    });

    return res.json({
      ok: true,
      sessionId: session.sessionId
    });
  } catch (err) {
    logger.error("session.start_error", { message: err && err.message ? err.message : String(err) });
    return res.status(500).json({ ok: false, code: "internal_error" });
  }
});

app.post("/session/kick", async (req, res) => {
  try {
    const body = req.body || {};
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        code: "invalid_payload",
        message: "sessionId required"
      });
    }

    const session = await sessionStore.getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        ok: false,
        code: "session_not_found"
      });
    }

    const result = await hotspotManager.kickSession(session);
    return res.json({
      ok: true,
      kicked: !!result.kicked,
      notFound: !!result.notFound,
      result
    });
  } catch (err) {
    logger.error("session.kick_endpoint_error", {
      message: err && err.message ? err.message : String(err)
    });
    return res.status(500).json({ ok: false, code: "internal_error" });
  }
});

app.get("/session/active", async (req, res) => {
  try {
    const sessions = (await sessionStore.listSessions()).map((session) => ({
      sessionId: session.sessionId,
      ip: session.ip,
      active: !!session.active,
      status: session.status
    }));

    return res.json({
      ok: true,
      sessions
    });
  } catch (err) {
    logger.error("session.active_list_error", { message: err && err.message ? err.message : String(err) });
    return res.status(500).json({ ok: false, code: "internal_error" });
  }
});

app.get("/session/:sessionId", async (req, res) => {
  try {
    const sessionId = String(req.params.sessionId || "").trim();
    const session = await sessionStore.getSession(sessionId);

    if (!session) {
      return res.status(404).json({
        ok: false,
        code: "session_not_found"
      });
    }

    logger.info("session.get", {
      sessionId: session.sessionId,
      ip: session.ip,
      mac: session.mac,
      router: session.router
    });

    return res.json({
      ok: true,
      session
    });
  } catch (err) {
    logger.error("session.get_error", { message: err && err.message ? err.message : String(err) });
    return res.status(500).json({ ok: false, code: "internal_error" });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith("/relay") || req.path.startsWith("/internal")) {
    return authMiddleware(req, res, next);
  }
  next();
});

// Healthcheck (cheap, no dependencies)
app.get("/relay/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Basic identity for backend UI (HMAC-protected)
app.get("/relay/identity", (req, res) => {
  res.json({
    ok: true,
    service: "relay",
    version: process.env.RELAY_VERSION || "unknown",
    node: process.version,
    uptime: process.uptime()
  });
});

// Router registry endpoints (backend UI)
app.use('/relay/routers', routerRegistry);

// Prometheus-style metrics snapshot
app.get("/relay/metrics", async (req, res) => {
  try {
    // base metrics from in-memory counters
    let body = renderPrometheus();

    // augment with job store counts (works with file/sqlite/redis)
    try {
      const jobs = await Promise.resolve(jobStore.listJobs());
      const now = Date.now();
      const total = Array.isArray(jobs) ? jobs.length : 0;
      const due = Array.isArray(jobs) ? jobs.filter(j => (Number(j.runAt || 0) <= now)).length : 0;
      const pending = total - due;
      const oldest = Array.isArray(jobs) && jobs.length ? Math.min(...jobs.map(j => Number(j.runAt || Infinity))) : 0;

      body += `relay_jobs_total ${total}\n`;
      body += `relay_jobs_due ${due}\n`;
      body += `relay_jobs_pending ${pending}\n`;
      body += `relay_jobs_oldest_run_at ${oldest}\n`;

      // processed events (dedupe set)
      try {
        const processed = await Promise.resolve(jobStore.listProcessedEventIds());
        const processedCount = Array.isArray(processed) ? processed.length : 0;
        body += `relay_processed_events_total ${processedCount}\n`;
      } catch (pe) {
        logger.error("relay.metrics.processed_events_error", { message: pe && pe.message });
        body += `# error reading processed event ids for metrics\n`;
      }
    } catch (e) {
      logger.error("relay.metrics.job_store_error", { message: e && e.message });
      body += `# error reading jobStore for metrics\n`;
    }

    res.setHeader("Content-Type", "text/plain; version=0.0.4");
    res.send(body);
  } catch (err) {
    logger.error('/relay/metrics error', err && err.message);
    res.status(500).send("# error generating metrics\n");
  }
});

// Mikrotik ARP print passthrough
app.post("/relay/arp-print", handleArpPrint);

// ARP lookup wrapper for dashboard contract
app.post("/relay/arp/lookup", handleArpLookup);

// Mikrotik ping passthrough
app.post("/relay/ping", async (req, res) => {
  try {
    const body = req.body || {};
    const { mikId, target, count = 3 } = body;
    if (!mikId || !target) return res.status(400).json({ ok: false, code: 'invalid_payload', message: 'mikId and target required' });
    if (!routerHealth.canAttempt(mikId)) return res.status(409).json({ ok: false, code: 'router_circuit_open' });
    const mik = getMikById(mikId);
    const cmds = [`/ping address=${target} count=${count}`];
    const result = await runMikrotikCommands(mik, cmds);
    return res.json({ ok: !!result.ok, mikId, target, result });
  } catch (e) { return handleError(res, e); }
});

// Exec sentences on Mikrotik by mikId (supports multiple commands)
app.post("/relay/exec-by-device", handleExecByDevice);
app.post("/relay/exec", handleRelayExec);

// Dashboard hotspot wrappers
app.post("/relay/hotspot/ensure-user", handleEnsureHotspotUser);
app.post("/hotspot/active", authMiddleware, handleHotspotActive);
app.get("/hotspot/active", authMiddleware, (req, res) =>
  res.status(400).json({
    ok: false,
    code: "invalid_method",
    message: "Use POST /hotspot/active with JSON body { mikId }"
  })
);
app.post("/hotspot/kick", authMiddleware, (req, res) => handleHotspotKick(req, res));
app.post("/hotspot/kick/by-ip", authMiddleware, (req, res) => handleHotspotKick(req, res, { ip: req.body && req.body.ip }));
app.post("/hotspot/kick/by-mac", authMiddleware, (req, res) => handleHotspotKick(req, res, { mac: req.body && req.body.mac }));
app.post("/hotspot/kick/by-user", authMiddleware, (req, res) => handleHotspotKick(req, res, { user: req.body && req.body.user }));

app.post("/relay/hotspot/upload-redirect", handleUploadRedirect);
app.post("/relay/upload-redirect", handleUploadRedirect);

/**
 * 1) device/hello
 * - Backend chama quando a página cativa carrega
 * - Se não tiver token, relay cria
 * - Se tiver, relay atualiza ip/mac
 */
app.post("/relay/device/hello", authMiddleware, (req, res) => {
  const ip = normalizeClientIp(req.ip);
  try {
    const { deviceToken, mikId, ip: bodyIp, mac, userAgent } = req.body;
    const normalizedBodyIp = normalizeIp(bodyIp);
    const normalizedMac = isValidMac(mac) ? normalizeMac(mac) : null;

    if (!mikId || !bodyIp || !mac) {
      logger.warn("device_hello.rejected", { reason: "missing_fields", ip, mikId });
      return res.status(400).json({
        ok: false,
        code: "invalid_payload",
        error: "Campos obrigatórios: mikId, ip, mac"
      });
    }
    if (!isValidIp(bodyIp)) {
      logger.warn("device_hello.rejected", {
        reason: "invalid_ip",
        ip,
        mikId,
        bodyIp
      });
      return res.status(400).json({
        ok: false,
        code: "invalid_ip",
        message: "invalid IP format"
      });
    }
    if (!normalizedMac) {
      logger.warn("device_hello.rejected", {
        reason: "invalid_mac",
        ip,
        mikId,
        mac
      });
      return res.status(400).json({
        ok: false,
        code: "invalid_mac",
        message: "invalid MAC format"
      });
    }

    // Validate that mikId is a known MikroTik node
    try {
      getMikById(mikId);
    } catch (e) {
      if (e.code === 'MIKROTIK_NODE_NOT_FOUND') {
        logger.warn("device_hello.rejected", { reason: "unknown_mikId", ip, mikId });
        return res.status(403).json({ ok: false, code: "unknown_router", error: "mikId not found in configured nodes" });
      }
      // If MIKROTIK_NODES is not configured, log warning but allow through
      logger.warn("device_hello.mikid_validation_skipped", { reason: e.code, ip, mikId });
    }

    const dev = registerOrUpdateDevice({
      deviceToken,
      mikId,
      ip: normalizedBodyIp,
      mac: normalizedMac,
      userAgent
    });

    res.json({
      ok: true,
      deviceToken: dev.token,
      mikId: dev.mikId,
      ipAtual: dev.ipAtual,
      macAtual: dev.macAtual
    });
  } catch (err) {
    logger.error("relay.device_hello.error", {
      message: err && err.message,
      stack: err && err.stack
    });
    res.status(500).json({ ok: false, code: "internal_error", error: err.message });
  }
});

// Helper to handle structured errors
function handleError(res, err) {
  if (err instanceof RelayError) {
    return res.status(err.status).json({ ok: false, code: err.code, message: err.message, meta: err.meta });
  }
  logger.error('http.unhandled_error', { message: err && err.message });
  return res.status(500).json({ ok: false, code: 'internal_error', message: 'internal error' });
}

function extractRowsFromMikrotikResult(result) {
  if (!result || !Array.isArray(result.results)) return [];
  const rows = [];
  for (const item of result.results) {
    const data = item && item.data;
    if (Array.isArray(data)) {
      for (const row of data) {
        if (row && typeof row === "object") rows.push(row);
      }
      continue;
    }
    if (data && typeof data === "object") rows.push(data);
  }
  return rows;
}

function pickFirst(value, keys) {
  for (const key of keys) {
    if (value && value[key] !== undefined && value[key] !== null) {
      return value[key];
    }
  }
  return null;
}

function ensureSafeToken(value, fieldName) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (!/^[A-Za-z0-9._:@-]{1,64}$/.test(raw)) {
    throw new Error(`${fieldName} contains invalid characters`);
  }
  return raw;
}

function getRequestId(req) {
  if (req && typeof req.id === "string" && req.id.trim()) {
    return req.id.trim();
  }
  const value = req && req.headers ? req.headers["x-request-id"] : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function escapeRouterOsQuoted(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, "\\r\\n");
}

function validateRedirectHtml(html) {
  if (typeof html !== "string" || html.length === 0) {
    return {
      ok: false,
      status: 400,
      code: "invalid_payload",
      message: "html required"
    };
  }
  if (!html.includes("$(mac)") || !html.includes("$(ip)")) {
    return {
      ok: false,
      status: 400,
      code: "invalid_payload",
      message: "html must include $(mac) and $(ip)"
    };
  }
  if (/<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i.test(html)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_payload",
      message: "external script references are not allowed"
    };
  }
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_REDIRECT_HTML_BYTES) {
    return {
      ok: false,
      status: 413,
      code: "payload_too_large",
      message: `html exceeds ${MAX_REDIRECT_HTML_BYTES} bytes`
    };
  }
  return { ok: true, value: html, bytes };
}

function validateRedirectPath(pathInput) {
  if (pathInput !== undefined && typeof pathInput !== "string") {
    return {
      ok: false,
      status: 400,
      code: "invalid_payload",
      message: "path must be a string"
    };
  }

  const pathValue = String(pathInput || DEFAULT_REDIRECT_PATH).trim() || DEFAULT_REDIRECT_PATH;
  if (pathValue.includes("..") || pathValue.includes("\\") || /[\u0000-\u001F\u007F]/.test(pathValue)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_payload",
      message: "invalid path"
    };
  }
  if (pathValue === DEFAULT_REDIRECT_PATH) {
    return { ok: true, value: pathValue };
  }
  if (!/^hotspot4\/[A-Za-z0-9._-]+\.html$/.test(pathValue)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_payload",
      message: "path must be hotspot4/<name>.html"
    };
  }
  return { ok: true, value: pathValue };
}

function parseEnsureHtmlDirectory(value) {
  if (value === undefined) return { ok: true, value: true };
  if (typeof value === "boolean") return { ok: true, value };
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return { ok: true, value: true };
    if (normalized === "false") return { ok: true, value: false };
  }
  return {
    ok: false,
    status: 400,
    code: "invalid_payload",
    message: "ensureHtmlDirectory must be boolean"
  };
}

function resolveProfileName(body) {
  const candidates = [
    body && body.hotspotProfile,
    process.env.RELAY_HOTSPOT_PROFILE_NAME,
    process.env.RELAY_HOTSPOT_PROFILE,
    DEFAULT_HOTSPOT_PROFILE
  ];
  for (const value of candidates) {
    const token = ensureSafeToken(value, "hotspotProfile");
    if (token) return token;
  }
  return DEFAULT_HOTSPOT_PROFILE;
}

function sendUploadRedirectMikrotikError(res, payload) {
  const {
    requestId,
    mikId,
    path,
    bytes,
    operation,
    result
  } = payload;
  logger.error("relay.upload_redirect.mikrotik_error", {
    requestId,
    mikId,
    path,
    bytes,
    operation,
    error: result && result.error ? result.error : null
  });
  return res.status(502).json({
    ok: false,
    code: "mikrotik_error",
    message: `${operation} failed`
  });
}

async function getFileByName(mik, fileName) {
  const escapedName = escapeRouterOsQuoted(fileName);
  const result = await runMikrotikCommands(mik, [`/file print where name="${escapedName}"`]);
  if (!result.ok) return { ok: false, result };

  const entries = extractRowsFromMikrotikResult(result);
  const entry = entries.find((row) => String(pickFirst(row, ["name"]) || "").trim() === fileName) || null;
  if (entry) return { ok: true, entry };

  const fallback = await runMikrotikCommands(mik, ["/file print"]);
  if (!fallback.ok) return { ok: false, result: fallback };
  const fallbackEntries = extractRowsFromMikrotikResult(fallback);
  const fallbackEntry = fallbackEntries.find((row) => String(pickFirst(row, ["name"]) || "").trim() === fileName) || null;
  return { ok: true, entry: fallbackEntry };
}

async function ensureHotspotDirectory(mik) {
  const existing = await getFileByName(mik, "hotspot4");
  if (!existing.ok) return existing;
  if (existing.entry) return { ok: true };

  const createResult = await runMikrotikCommands(mik, ["/file make-directory name=hotspot4"]);
  if (createResult.ok) return { ok: true };

  const recheck = await getFileByName(mik, "hotspot4");
  if (recheck.ok && recheck.entry) return { ok: true };
  return { ok: false, result: createResult };
}

async function removeFileIfExists(mik, fileName) {
  const lookup = await getFileByName(mik, fileName);
  if (!lookup.ok) return lookup;
  if (!lookup.entry) return { ok: true, removed: false };

  const fileId = String(pickFirst(lookup.entry, [".id", "id"]) || "").trim();
  const escapedName = escapeRouterOsQuoted(fileName);
  const command = fileId
    ? `/file remove ${fileId}`
    : `/file remove [find name="${escapedName}"]`;
  const removeResult = await runMikrotikCommands(mik, [command]);
  if (!removeResult.ok) return { ok: false, result: removeResult };
  return { ok: true, removed: true };
}

async function ensureHotspotProfileHtmlDirectory(mik, profileName) {
  const escapedProfile = escapeRouterOsQuoted(profileName);
  const checkResult = await runMikrotikCommands(
    mik,
    [`/ip hotspot profile print where name="${escapedProfile}"`]
  );
  if (!checkResult.ok) return { ok: false, code: "mikrotik_error", result: checkResult };

  const profiles = extractRowsFromMikrotikResult(checkResult);
  if (profiles.length === 0) return { ok: false, code: "profile_not_found" };

  const setResult = await runMikrotikCommands(
    mik,
    [`/ip hotspot profile set [find name="${escapedProfile}"] html-directory=hotspot4 html-directory-override=""`]
  );
  if (!setResult.ok) return { ok: false, code: "mikrotik_error", result: setResult };
  return { ok: true };
}

function normalizeArpEntry(row) {
  return {
    address: String(pickFirst(row, ["address", "ip"]) || "").trim() || null,
    macAddress: normalizeMacAddress(pickFirst(row, ["mac-address", "mac", "macAddress"])),
    interface: String(pickFirst(row, ["interface"]) || "").trim() || null,
    dynamic: String(pickFirst(row, ["dynamic"]) || "").trim() || null,
    complete: String(pickFirst(row, ["complete"]) || "").trim() || null,
    comment: String(pickFirst(row, ["comment"]) || "").trim() || null
  };
}

function normalizeHotspotActiveEntry(row) {
  return {
    id: String(pickFirst(row, [".id", "id"]) || "").trim() || null,
    user: String(pickFirst(row, ["user", "name"]) || "").trim() || null,
    ip: String(pickFirst(row, ["address", "ip"]) || "").trim() || null,
    mac: normalizeMacAddress(pickFirst(row, ["mac-address", "mac", "macAddress"])),
    uptime: String(pickFirst(row, ["uptime"]) || "").trim() || null,
    server: String(pickFirst(row, ["server"]) || "").trim() || null
  };
}

function assertMikrotikEligible(mikId, res) {
  if (!mikId) {
    res.status(400).json({ ok: false, code: "invalid_payload", message: "mikId required" });
    return false;
  }
  if (!routerHealth.canAttempt(mikId)) {
    res.status(409).json({ ok: false, code: "router_circuit_open" });
    return false;
  }
  return true;
}

async function runArpPrint(mikId) {
  const mik = getMikById(mikId);
  return runMikrotikCommands(mik, ["/ip/arp/print"]);
}

async function runHotspotActivePrint(mikId) {
  const mik = getMikById(mikId);
  return runMikrotikCommands(mik, ["/ip hotspot active print"]);
}

async function validateSingleActiveHotspot(mik) {
  const result = await runMikrotikCommands(mik, ["/ip hotspot print"]);
  if (!result.ok) return { ok: false, code: "mikrotik_error", result };

  const hotspots = extractRowsFromMikrotikResult(result);
  const activeHotspots = hotspots.filter((row) => {
    const rawDisabled = pickFirst(row, ["disabled"]);
    if (rawDisabled === true) return false;
    const normalized = String(rawDisabled === undefined || rawDisabled === null ? "" : rawDisabled)
      .trim()
      .toLowerCase();
    return !(normalized === "true" || normalized === "yes" || normalized === "1");
  });

  if (activeHotspots.length > 1) {
    return {
      ok: false,
      code: "multiple_hotspots_active",
      message: "more than one hotspot server is enabled"
    };
  }

  const activeHotspot = activeHotspots[0] || null;
  const activeProfile = activeHotspot
    ? String(pickFirst(activeHotspot, ["profile"]) || "").trim() || null
    : null;

  return {
    ok: true,
    activeProfile
  };
}

function matchesHotspotCriteria(entry, criteria) {
  if (criteria.ip && entry.ip !== criteria.ip) return false;
  if (criteria.mac && entry.mac !== criteria.mac) return false;
  if (criteria.user && entry.user !== criteria.user) return false;
  return true;
}

function buildHotspotKickCommands(criteria) {
  const commands = [];
  if (criteria.ip) {
    commands.push(`/ip hotspot active remove [find address=${criteria.ip}]`);
    commands.push(`/ip hotspot host remove [find address=${criteria.ip}]`);
    commands.push(`/ip hotspot cookie remove [find address=${criteria.ip}]`);
  }
  if (criteria.mac) {
    commands.push(`/ip hotspot active remove [find mac-address=${criteria.mac}]`);
    commands.push(`/ip hotspot host remove [find mac-address=${criteria.mac}]`);
    commands.push(`/ip hotspot cookie remove [find mac-address=${criteria.mac}]`);
  }
  if (criteria.user) {
    commands.push(`/ip hotspot active remove [find user=${criteria.user}]`);
    commands.push(`/ip hotspot cookie remove [find user=${criteria.user}]`);
  }
  return [...new Set(commands)];
}

async function handleExecByDevice(req, res) {
  try {
    const body = req.body || {};
    const { mikId, sentences } = body;
    if (!mikId || !Array.isArray(sentences) || sentences.length === 0) {
      return res.status(400).json({ ok: false, code: "invalid_payload", message: "mikId and sentences[] required" });
    }
    if (!routerHealth.canAttempt(mikId)) return res.status(409).json({ ok: false, code: "router_circuit_open" });
    const filtered = sentences.filter((s) => typeof s === "string" && s.trim().length > 0);
    if (filtered.length === 0) {
      return res.status(400).json({ ok: false, code: "invalid_payload", message: "sentences must be non-empty strings" });
    }
    const mik = getMikById(mikId);
    const result = await runMikrotikCommands(mik, filtered);
    return res.json({ ok: !!result.ok, mikId, result });
  } catch (e) {
    return handleError(res, e);
  }
}

async function handleRelayExec(req, res) {
  try {
    const body = req.body || {};
    const host = String(body.host || "").trim();
    const user = String(body.user || "").trim();
    const pass = String(body.pass || "").trim();
    const port = body.port === undefined || body.port === null || body.port === ""
      ? 8728
      : Number(body.port);
    const command = String(body.command || "").trim();
    const params = body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? body.params
      : {};

    if (!host || !user || !pass || !command || !Number.isInteger(port) || port <= 0) {
      return res.status(400).json({
        ok: false,
        code: "invalid_payload",
        message: "host, user, pass, port and command are required"
      });
    }

    const sentence = buildSentence(command, params);
    const result = await runMikrotikCommands({ host, user, pass, port }, [sentence]);

    if (result.ok) {
      logger.info("relay.exec.success", {
        host,
        port,
        command,
        hasParams: Object.keys(params).length > 0
      });
    } else {
      logger.error("relay.exec.error", {
        host,
        port,
        command,
        hasParams: Object.keys(params).length > 0,
        error: result.error || null
      });
    }

    if (!result.ok) {
      const message = result.error && result.error.message
        ? result.error.message
        : "failed to execute command";
      return res.status(502).json({
        ok: false,
        code: "EXEC_ERROR",
        message,
        result
      });
    }

    return res.status(200).json({ ok: true, result });
  } catch (e) {
    logger.error("relay.exec.error", {
      message: e && e.message ? e.message : String(e)
    });
    return res.status(500).json({
      ok: false,
      code: "EXEC_ERROR",
      message: e && e.message ? e.message : "failed to execute command"
    });
  }
}

async function handleArpPrint(req, res) {
  try {
    const body = req.body || {};
    const { mikId } = body;
    if (!assertMikrotikEligible(mikId, res)) return;
    const result = await runArpPrint(mikId);
    return res.json({ ok: !!result.ok, mikId, result });
  } catch (e) {
    return handleError(res, e);
  }
}

async function handleArpLookup(req, res) {
  try {
    const body = req.body || {};
    const { mikId } = body;
    const ip = body.ip ? normalizeIp(body.ip) : null;
    const mac = body.mac ? normalizeMacAddress(body.mac) : null;
    if (!assertMikrotikEligible(mikId, res)) return;
    if (body.ip && !ip) {
      return res.status(400).json({ ok: false, code: "invalid_payload", message: "invalid ip format" });
    }
    if (body.mac && !mac) {
      return res.status(400).json({ ok: false, code: "invalid_payload", message: "invalid mac format" });
    }
    if (!ip && !mac) {
      return res.status(400).json({ ok: false, code: "invalid_payload", message: "ip or mac required" });
    }

    const result = await runArpPrint(mikId);
    const entries = extractRowsFromMikrotikResult(result).map(normalizeArpEntry);
    const entry = entries.find((item) => {
      if (ip && item.address !== ip) return false;
      if (mac && item.macAddress !== mac) return false;
      return true;
    }) || null;

    return res.json({
      ok: true,
      mikId,
      found: !!entry,
      entry
    });
  } catch (e) {
    return handleError(res, e);
  }
}

async function handleEnsureHotspotUser(req, res) {
  try {
    const body = req.body || {};
    const { mikId } = body;
    if (!assertMikrotikEligible(mikId, res)) return;

    const username = body.username
      ? ensureSafeToken(body.username, "username")
      : `relay-${Date.now().toString(36)}`;
    const password = body.password
      ? ensureSafeToken(body.password, "password")
      : username;
    const profile = body.profile
      ? ensureSafeToken(body.profile, "profile")
      : (process.env.RELAY_HOTSPOT_PROFILE || "default");

    const mik = getMikById(mikId);
    const checkResult = await runMikrotikCommands(mik, [`/ip hotspot user print where name=${username}`]);
    const existing = extractRowsFromMikrotikResult(checkResult).length > 0;
    const command = existing
      ? `/ip hotspot user set [find name=${username}] password=${password} profile=${profile}`
      : `/ip hotspot user add name=${username} password=${password} profile=${profile}`;
    const writeResult = await runMikrotikCommands(mik, [command]);

    return res.json({
      ok: !!writeResult.ok,
      mikId,
      user: { username, profile },
      created: !existing
    });
  } catch (e) {
    if (e && /invalid characters/i.test(e.message || "")) {
      return res.status(400).json({ ok: false, code: "invalid_payload", message: e.message });
    }
    return handleError(res, e);
  }
}

async function handleHotspotActive(req, res) {
  try {
    const body = req.body || {};
    const mikId = String(body.mikId || req.query.mikId || "").trim();
    if (!assertMikrotikEligible(mikId, res)) return;
    const result = await runHotspotActivePrint(mikId);
    const active = extractRowsFromMikrotikResult(result).map(normalizeHotspotActiveEntry);
    return res.json({ ok: !!result.ok, mikId, active });
  } catch (e) {
    return handleError(res, e);
  }
}

async function handleHotspotKick(req, res, forcedCriteria = null) {
  try {
    const body = req.body || {};
    const mikId = String(body.mikId || "").trim();
    if (!assertMikrotikEligible(mikId, res)) return;

    const inputIp = forcedCriteria && forcedCriteria.ip !== undefined ? forcedCriteria.ip : body.ip;
    const inputMac = forcedCriteria && forcedCriteria.mac !== undefined ? forcedCriteria.mac : body.mac;
    const inputUser = forcedCriteria && forcedCriteria.user !== undefined ? forcedCriteria.user : body.user;

    const ip = inputIp ? normalizeIp(inputIp) : null;
    const mac = inputMac ? normalizeMacAddress(inputMac) : null;
    const user = inputUser ? ensureSafeToken(inputUser, "user") : null;

    if (inputIp && !ip) {
      return res.status(400).json({ ok: false, code: "invalid_payload", message: "invalid ip format" });
    }
    if (inputMac && !mac) {
      return res.status(400).json({ ok: false, code: "invalid_payload", message: "invalid mac format" });
    }
    if (inputUser && !user) {
      return res.status(400).json({ ok: false, code: "invalid_payload", message: "invalid user format" });
    }
    if (!ip && !mac && !user) {
      return res.status(400).json({ ok: false, code: "invalid_payload", message: "ip, mac or user required" });
    }

    const criteria = { ip, mac, user };
    const activeResult = await runHotspotActivePrint(mikId);
    const active = extractRowsFromMikrotikResult(activeResult).map(normalizeHotspotActiveEntry);
    const matched = active.filter((entry) => matchesHotspotCriteria(entry, criteria));

    const commands = buildHotspotKickCommands(criteria);
    const mik = getMikById(mikId);
    const removeResult = commands.length > 0
      ? await runMikrotikCommands(mik, commands)
      : { ok: true, results: [] };

    return res.json({
      ok: !!removeResult.ok,
      mikId,
      kicked: matched.length,
      criteria
    });
  } catch (e) {
    if (e && /invalid characters/i.test(e.message || "")) {
      return res.status(400).json({ ok: false, code: "invalid_payload", message: e.message });
    }
    return handleError(res, e);
  }
}

async function handleUploadRedirect(req, res) {
  const requestId = getRequestId(req);
  let mikId = null;
  let path = null;
  let bytes = 0;
  let profileUsed = null;
  let ensuredHtmlDirectory;

  try {
    const body = req.body || {};
    mikId = String(body.mikId || "").trim();
    if (!assertMikrotikEligible(mikId, res)) return;

    const htmlValidation = validateRedirectHtml(body.html);
    if (!htmlValidation.ok) {
      return res.status(htmlValidation.status).json({
        ok: false,
        code: htmlValidation.code,
        message: htmlValidation.message
      });
    }

    const pathValidation = validateRedirectPath(body.path);
    if (!pathValidation.ok) {
      return res.status(pathValidation.status).json({
        ok: false,
        code: pathValidation.code,
        message: pathValidation.message
      });
    }

    const ensureValidation = parseEnsureHtmlDirectory(body.ensureHtmlDirectory);
    if (!ensureValidation.ok) {
      return res.status(ensureValidation.status).json({
        ok: false,
        code: ensureValidation.code,
        message: ensureValidation.message
      });
    }

    const html = htmlValidation.value;
    bytes = htmlValidation.bytes;
    path = pathValidation.value;
    ensuredHtmlDirectory = ensureValidation.value;
    profileUsed = ensuredHtmlDirectory ? resolveProfileName(body) : null;

    const mik = getMikById(mikId);
    const hotspotValidation = await validateSingleActiveHotspot(mik);
    if (!hotspotValidation.ok) {
      if (hotspotValidation.code === "multiple_hotspots_active") {
        return res.status(409).json({
          ok: false,
          code: "multiple_hotspots_active",
          message: "more than one hotspot server is enabled"
        });
      }
      return sendUploadRedirectMikrotikError(res, {
        requestId,
        mikId,
        path,
        bytes,
        operation: "validate_single_active_hotspot",
        result: hotspotValidation.result
      });
    }

    if (profileUsed && hotspotValidation.activeProfile && hotspotValidation.activeProfile !== profileUsed) {
      logger.warn("relay.upload_redirect.profile_mismatch", {
        requestId,
        mikId,
        path,
        bytes,
        activeProfile: hotspotValidation.activeProfile,
        profileUsed
      });
    }

    if (ensuredHtmlDirectory) {
      const profileResult = await ensureHotspotProfileHtmlDirectory(mik, profileUsed);
      if (!profileResult.ok) {
        if (profileResult.code === "profile_not_found") {
          logger.warn("relay.upload_redirect.profile_not_found", {
            requestId,
            mikId,
            path,
            bytes,
            profileUsed
          });
          return res.status(404).json({
            ok: false,
            code: "profile_not_found",
            message: `hotspot profile not found: ${profileUsed}`
          });
        }
        return sendUploadRedirectMikrotikError(res, {
          requestId,
          mikId,
          path,
          bytes,
          operation: "set_hotspot_profile_html_directory",
          result: profileResult.result
        });
      }
    }

    const ensureDirResult = await ensureHotspotDirectory(mik);
    if (!ensureDirResult.ok) {
      return sendUploadRedirectMikrotikError(res, {
        requestId,
        mikId,
        path,
        bytes,
        operation: "ensure_hotspot4_directory",
        result: ensureDirResult.result
      });
    }

    const removeResult = await removeFileIfExists(mik, path);
    if (!removeResult.ok) {
      return sendUploadRedirectMikrotikError(res, {
        requestId,
        mikId,
        path,
        bytes,
        operation: "remove_existing_redirect_file",
        result: removeResult.result
      });
    }

    const escapedPath = escapeRouterOsQuoted(path);
    const escapedHtml = escapeRouterOsQuoted(html);
    const addResult = await runMikrotikCommands(
      mik,
      [`/file add name="${escapedPath}" contents="${escapedHtml}"`]
    );
    if (!addResult.ok) {
      return sendUploadRedirectMikrotikError(res, {
        requestId,
        mikId,
        path,
        bytes,
        operation: "upload_redirect_file",
        result: addResult
      });
    }

    logger.info("relay.upload_redirect.success", {
      requestId,
      mikId,
      path,
      bytes,
      ensuredHtmlDirectory,
      profileUsed
    });

    return res.status(200).json({
      ok: true,
      mikId,
      path,
      bytes,
      ensuredHtmlDirectory,
      profileUsed
    });
  } catch (e) {
    if (e && /invalid characters/i.test(e.message || "")) {
      return res.status(400).json({
        ok: false,
        code: "invalid_payload",
        message: e.message
      });
    }

    logger.error("relay.upload_redirect.error", {
      requestId,
      mikId,
      path,
      bytes,
      message: e && e.message
    });
    return handleError(res, e);
  }
}

// Devices API (provision/deprovision/sync/status)
app.post('/devices', authMiddleware, async (req, res) => {
  try {
    const payload = req.body;
    const result = await relayManager.provisionDevice(payload);
    res.json(result);
  } catch (e) { return handleError(res, e); }
});

app.delete('/devices/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    const result = await relayManager.deprovisionDevice(id);
    res.json(result);
  } catch (e) { return handleError(res, e); }
});

app.post('/devices/:id/sync', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    const result = await relayManager.syncDevice(id);
    res.json(result);
  } catch (e) { return handleError(res, e); }
});

app.get('/devices/:id/status', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    const status = await relayManager.healthCheck(id);
    res.json(status);
  } catch (e) { return handleError(res, e); }
});

/**
 * POST /mikrotik/bootstrap
 * Body: { deviceId, devicePublicKey?, tunnelIp, allowedIps? }
 * If devicePublicKey provided: create peer on VPS and return Mikrotik CLI to apply on device (safe, no private keys).
 * If not provided: return step-by-step instructions to generate key on Mikrotik and continue.
 */
app.post('/mikrotik/bootstrap', authMiddleware, async (req, res) => {
  try {
    const { deviceId, devicePublicKey, tunnelIp, allowedIps } = req.body || {};
    if (!deviceId || !tunnelIp) return res.status(400).json({ ok: false, code: 'invalid_payload', message: 'deviceId and tunnelIp required' });

    const vpsPub = process.env.WG_VPS_PUBLIC_KEY;
    const vpsEndpoint = process.env.WG_VPS_ENDPOINT; // host:port or host
    if (!vpsPub || !vpsEndpoint) {
      return res.status(500).json({ ok: false, code: 'vps_config_missing', message: 'WG_VPS_PUBLIC_KEY and WG_VPS_ENDPOINT must be configured in env' });
    }

    // Build basic mikrotik commands template (no private keys, placeholders where needed)
    const endpointParts = vpsEndpoint.split(':');
    const endpointHost = endpointParts[0];
    const endpointPort = endpointParts[1] || '51820';

    const allowed = allowedIps || `${tunnelIp}/32`;

    if (!devicePublicKey) {
      const instructions = [
        'STEP 1: On the MikroTik device (Winbox/Terminal) generate a WireGuard keypair and note the public key.',
        '  - In recent RouterOS: use Winbox > Interfaces > WireGuard > Generate Key (or use a suitable tool to create keypair).',
        '  - Save the private key on the MikroTik interface; do NOT send it to anyone.',
        '',
        'STEP 2: After generating the public key, call your backend API to register the device public key and re-run this bootstrap endpoint.',
        '  - Example payload to backend: { deviceId: "<id>", publicKey: "<mikrotik-public-key>", tunnelIp: "<tunnel-ip>" }',
        '',
        'STEP 3: Once backend has registered the public key, re-run this endpoint to create the VPS peer and obtain the final MikroTik commands.'
      ];
      return res.json({ ok: true, needPublicKey: true, instructions });
    }

    // create peer on VPS (idempotent)
    try {
      const wgRes = await wgManager.addPeer({ deviceId, publicKey: devicePublicKey, allowedIps: allowed });
      // Compose MikroTik CLI commands to paste (no private keys)
      const commands = [];
      commands.push('# Create WireGuard interface (choose a name, here wg-relay)');
      commands.push(`/interface/wireguard add name=wg-relay comment="managed-by-relay deviceId:${deviceId}"`);
      commands.push('# Assign tunnel address to the MikroTik side');
      commands.push(`/ip address add address=${tunnelIp}/32 interface=wg-relay comment="tunnel for deviceId:${deviceId}"`);
      commands.push('# Add VPS as peer on the MikroTik: replace <vps-public-key> and <endpoint> already filled below');
      commands.push(`/interface/wireguard peers add interface=wg-relay public-key="${vpsPub}" allowed-address=${allowed} endpoint-address=${endpointHost} endpoint-port=${endpointPort} persistent-keepalive=25 comment="vps-peer deviceId:${deviceId}"`);
      commands.push('');
      commands.push('# Notes:');
      commands.push('# - You must generate a private key on the MikroTik WireGuard interface (do NOT send it to the relay).');
      commands.push('# - After adding the VPS peer, verify handshake with: /interface/wireguard print and /interface/wireguard peers print');

      return res.json({ ok: true, createdPeer: wgRes, commands });
    } catch (e) {
      logger.error('mikrotik.bootstrap_error', { message: e && e.message });
      return res.status(500).json({ ok: false, code: 'wg_peer_failed', message: e && e.message });
    }
  } catch (e) {
    if (e instanceof RelayError) return res.status(e.status).json({ ok: false, code: e.code, message: e.message });
    logger.error('mikrotik.bootstrap_unhandled', { message: e && e.message });
    return res.status(500).json({ ok: false, code: 'internal_error' });
  }
});

// POST /relay/manager/register
app.post('/relay/manager/register', async (req, res) => {
  try {
    const body = req.body || {};
    const { deviceId, deviceName, mikrotik = {}, wireguard = {} } = body;
    if (!deviceId || !mikrotik.publicIp || !mikrotik.apiUser || !mikrotik.apiPassword || !wireguard.peerPublicKey) {
      return res.status(400).json({ ok: false, code: 'invalid_payload', message: 'mikrotik credentials are required' });
    }

    // Do not persist passwords. Store metadata without apiPassword.
    const vpsPub = process.env.WG_VPS_PUBLIC_KEY;
    const vpsEndpoint = process.env.WG_VPS_ENDPOINT;
    if (!vpsPub || !vpsEndpoint) return res.status(500).json({ ok: false, code: 'vps_config_missing', message: 'WG_VPS_PUBLIC_KEY and WG_VPS_ENDPOINT required in env' });

    // deterministic tunnel IP allocation in 10.200.0.0/16 based on deviceId
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256').update(deviceId).digest();
    const a = hash[0] % 254 + 1; // 1..254
    const b = hash[1] % 254 + 1;
    const tunnelIp = `10.200.${a}.${b}`;

    const allowedIps = wireguard.allowedIps || `${tunnelIp}/32`;

    // create peer on VPS (idempotent)
    const addRes = await wgManager.addPeer({ deviceId, publicKey: wireguard.peerPublicKey, allowedIps });

    // persist metadata (without storing apiPassword)
    try {
      registerDevice({ deviceId, publicKey: wireguard.peerPublicKey, allowedIps, meta: { deviceName, mikrotik: { publicIp: mikrotik.publicIp, apiUser: mikrotik.apiUser, apiPort: mikrotik.apiPort || 8728 }, tunnelIp } });
    } catch (e) {
      logger.error('register.persist_error', { message: e && e.message });
    }

    // prepare Mikrotik script
    const endpointParts = vpsEndpoint.split(':');
    const endpointHost = endpointParts[0];
    const endpointPort = endpointParts[1] || '51820';
    const scriptLines = [];
    scriptLines.push('/interface/wireguard add name=wg-relay comment="managed-by-relay deviceId:' + deviceId + '"');
    scriptLines.push('# Set the private key on the MikroTik interface (do NOT send it to the relay)');
    scriptLines.push('# Example (on MikroTik): /interface/wireguard set wg-relay private-key="<PASTE_PRIVATE_KEY_HERE>"');
    scriptLines.push(`/ip address add address=${tunnelIp}/32 interface=wg-relay comment="tunnel for deviceId:${deviceId}"`);
    scriptLines.push('/interface/wireguard peers add interface=wg-relay public-key="' + vpsPub + '" endpoint-address=' + endpointHost + ' endpoint-port=' + endpointPort + ' allowed-address=' + allowedIps + ' persistent-keepalive=25 comment="vps-peer deviceId:' + deviceId + '"');
    scriptLines.push('# After applying, verify handshake and routes.');

    return res.json({ success: true, mikrotikScript: scriptLines.join('\n'), createdPeer: addRes, tunnelIp });
  } catch (e) {
    logger.error('relay.manager.register_error', { message: e && e.message });
    return res.status(500).json({ ok: false, code: 'internal_error' });
  }
});

/**
 * 2) authorize-by-pedido
 * - Webhook Pix confirmando pagamento
 * - Backend manda pedidoId, mikId, deviceToken
 */
app.post("/relay/authorize-by-pedido", async (req, res) => {
  try {
    const { pedidoId, mikId, deviceToken } = req.body;
    if (!pedidoId || !mikId || !deviceToken) {
      return res.status(400).json({
        error: "Campos obrigatórios: pedidoId, mikId, deviceToken"
      });
    }

    const result = await authorizeByPedido({ pedidoId, mikId, deviceToken });
    res.json(result);
  } catch (err) {
    logger.error("relay.authorize_by_pedido.error", {
      message: err && err.message,
      stack: err && err.stack
    });
    res.status(500).json({ error: err.message });
  }
});

/**
 * 3) resync-device
 * - Botão "já paguei e não liberou"
 * - Backend manda pedidoId, mikId, deviceToken, ipAtual, macAtual
 */
app.post("/relay/resync-device", async (req, res) => {
  try {
    const { pedidoId, mikId, deviceToken, ipAtual, macAtual } = req.body;

    if (!pedidoId || !mikId || !deviceToken || !ipAtual || !macAtual) {
      return res.status(400).json({
        error: "Campos obrigatórios: pedidoId, mikId, deviceToken, ipAtual, macAtual"
      });
    }

    const result = await resyncDevice({ pedidoId, mikId, deviceToken, ipAtual, macAtual });
    res.json(result);
  } catch (err) {
    logger.error("relay.resync_device.error", {
      message: err && err.message,
      stack: err && err.stack
    });
    res.status(500).json({ error: err.message });
  }
});

/**
 * 4) revoke
 * - Usado por scheduler ou painel técnico pra derrubar sessão
 */
app.post("/relay/revoke", async (req, res) => {
  try {
    const { mikId, ip, mac } = req.body;
    if (!mikId || (!ip && !mac)) {
      return res.status(400).json({
        error: "Campos obrigatórios: mikId e (ip ou mac)"
      });
    }

    const result = await revokeBySession({ mikId, ip, mac });
    res.json(result);
  } catch (err) {
    logger.error("relay.revoke.error", {
      message: err && err.message,
      stack: err && err.stack
    });
    res.status(500).json({ error: err.message });
  }
});

// New unified action endpoint (allowlist + audit + validation)
app.post("/relay/action", async (req, res) => {
  try {
    const { action, payload, source, traceId } = req.body || {};
    const result = await executeAction({ action, payload, source, traceId });
    if (result && result.ok) {
      res.json(result);
    } else {
      const status = result && result.status ? result.status : 400;
      res.status(status).json(result);
    }
  } catch (err) {
    logger.error("relay.action.error", {
      message: err && err.message,
      stack: err && err.stack
    });
    res.status(500).json({ error: err.message });
  }
});

// Identity refresh: resolve sid -> pending payment -> authorize with current IP/MAC
app.post("/relay/identity/refresh", async (req, res) => {
  try {
    const { sid, mac, ip, routerHint, identity } = req.body || {};
    const ipToUse = ip || req.ip;
    const result = await identityService.refreshAndAuthorize({ sid, mac, ip: ipToUse, routerHint, identity });
    if (result && result.ok) {
      return res.json(result);
    }
    const status = result && result.code === 'no_pending_payment' ? 404 : 400;
    return res.status(status).json({ ok: false, ...result });
  } catch (e) {
    return handleError(res, e);
  }
});

// Identity status
app.get("/relay/identity/status", async (req, res) => {
  try {
    const sid = String(req.query.sid || '').trim();
    if (!sid) return res.status(400).json({ ok: false, code: 'missing_sid' });

    const opsMode = true;

    const identity = await identityStore.getIdentity(sid);
    if (!identity) {
      return res.json({
        ok: true,
        sid,
        public: {
          state: "NO_PENDING_PAYMENT",
          authorized: false,
          pendingAuthorization: false,
          retryInMs: 0,
          messageCode: "awaiting_payment",
          expiresAt: null,
          planId: null,
          routerId: null,
          updatedAt: new Date().toISOString()
        },
        ops: opsMode ? { pending: null, lastSeen: null, applied: null, routerHealth: null } : null
      });
    }

    const pending = identity.pending || identity.pendingPedido || identity.pendingPedido === null ? identity.pendingPedido || identity.pending : null;
    const lastSeen = identity.lastSeen || null;

    const routerId = (pending && pending.routerId) || (lastSeen && (lastSeen.identity || lastSeen.routerHint)) || null;
    const health = routerId ? routerHealth.getHealth(routerId) : null;
    const now = Date.now();

    const openUntilMs = health && health.openUntil ? Number(health.openUntil) : (health && health.openUntil !== undefined ? health.openUntil : 0);
    const nextRetryAtMs = health && health.nextRetryAt ? Number(health.nextRetryAt) : (health && health.nextRetryAt !== undefined ? health.nextRetryAt : 0);
    const nextEligibleAtMs = pending && pending.nextEligibleAt ? Number(pending.nextEligibleAt) : 0;

    const retryInMs = Math.max(
      0,
      openUntilMs ? Math.max(0, openUntilMs - now) : 0,
      nextEligibleAtMs ? Math.max(0, nextEligibleAtMs - now) : 0,
      nextRetryAtMs ? Math.max(0, nextRetryAtMs - now) : 0
    );

    let state = "NO_PENDING_PAYMENT";
    if (pending) {
      if (pending.status === 'APPLIED') state = "AUTHORIZED";
      else if (pending.status === 'FAILED') state = "FAILED";
      else state = "PENDING";
    }

    const pendingStatus = pending ? pending.status : null;
    const messageCode = (() => {
      if (state === "AUTHORIZED") return "authorized";
      if (state === "NO_PENDING_PAYMENT") return "awaiting_payment";
      if (pendingStatus === "FAILED") {
        if (retryInMs > 0) return "cooldown_active";
        return "authorization_failed_after_retries";
      }
      if (retryInMs > 0) return "authorization_scheduled";
      return "authorization_scheduled";
    })();

    const publicPayload = {
      state,
      authorized: state === "AUTHORIZED",
      pendingAuthorization: state === "PENDING" && retryInMs > 0,
      retryInMs,
      messageCode,
      expiresAt: pending && pending.expiresAt ? pending.expiresAt : null,
      planId: pending && pending.planId ? pending.planId : null,
      routerId,
      updatedAt: new Date().toISOString()
    };

    const opsPayload = opsMode ? {
      pending: pending ? {
        status: pending.status,
        pedidoId: pending.pedidoId || null,
        planId: pending.planId || null,
        routerId: pending.routerId || null,
        attempts: pending.attempts || 0,
        failCode: pending.failCode || null,
        failedAt: pending.failedAt || null,
        nextEligibleAt: pending.nextEligibleAt || null,
        expiresAt: pending.expiresAt || null
      } : null,
      lastSeen: lastSeen ? {
        ip: lastSeen.ip || null,
        mac: lastSeen.mac || null,
        identity: lastSeen.identity || null,
        routerHint: lastSeen.routerHint || null,
        ts: lastSeen.ts || null
      } : null,
      applied: Array.isArray(identity.applied) && identity.applied.length ? {
        lastActionKey: identity.applied[identity.applied.length - 1].actionKey || null,
        lastAppliedAt: identity.applied[identity.applied.length - 1].at || null,
        recentKeys: identity.applied.map(a => a.actionKey)
      } : null,
      routerHealth: health ? {
        routerId,
        state: health.state,
        lastErrCode: health.lastErrCode || null,
        consecutiveFails: health.consecutiveFails || 0,
        openUntil: health.openUntil || null,
        nextRetryAt: health.nextRetryAt || null
      } : null
    } : null;

    return res.json({ ok: true, sid, public: publicPayload, ops: opsPayload });
  } catch (e) {
    logger.error('identity.status_error', { message: e && e.message });
    return res.status(500).json({ ok: false, code: 'internal_error' });
  }
});

// Retry-now
app.post("/relay/identity/retry-now", async (req, res) => {
  try {
    const sid = String(req.body && req.body.sid || '').trim();
    if (!sid) return res.status(400).json({ ok: false, code: 'missing_sid' });

    // rate limit per sid for retry-now
    const now = Date.now();
    const last = lastRetryNowBySid.get(sid) || 0;
    if (now - last < RETRY_NOW_COOLDOWN_MS) {
      const retryInMs = RETRY_NOW_COOLDOWN_MS - (now - last);
      return res.status(429).json({ ok: false, code: 'retry_rate_limited', retryInMs });
    }

    const identity = await identityStore.getIdentity(sid);
    const pending = identity && (identity.pendingPedido || identity.pending);
    if (!pending) return res.status(404).json({ ok: false, code: 'no_pending' });

    // schedule immediate retry (override cooldown)
    await identityService.scheduleAuthorizePending({
      sid,
      pedidoId: pending.pedidoId,
      routerId: pending.routerId,
      routerHint: pending.routerId,
      identity: pending.routerId,
      ip: identity && identity.lastSeen ? identity.lastSeen.ip : null,
      mac: identity && identity.lastSeen ? identity.lastSeen.mac : null,
      attempt: 0
    });

    lastRetryNowBySid.set(sid, now);
    // audit override
    try {
      audit.auditAttempt({ type: 'OPS_RETRY_NOW_OVERRIDE_COOLDOWN', sid, pedidoId: pending.pedidoId, routerId: pending.routerId });
    } catch (_) {}

    return res.json({ ok: true, scheduled: true, jobType: 'AUTHORIZE_PENDING', runInMs: 0 });
  } catch (e) {
    logger.error('identity.retry_now_error', { message: e && e.message });
    return res.status(500).json({ ok: false, code: 'internal_error' });
  }
});

// Internal WireGuard peers status (protected by Bearer + HMAC)
app.get('/internal/wireguard/peers/status', async (req, res) => {
  try {
    // get raw status from wg reader
    const raw = await wireguardStatus.getPeersStatus();

    // enrich with binding information (deviceId, mikrotikIp) when available
    try {
      const bindings = await peerBinding.listBindings();
      const map = new Map(bindings.map(b => [b.publicKey, { deviceId: b.deviceId, mikrotikIp: b.mikrotikIp, createdAt: b.createdAt }]));
      const peers = (raw.peers || []).map(p => {
        const device = map.get(p.publicKey) || null;
        return { ...p, device };
      });
      return res.json({ timestamp: raw.timestamp, peers });
    } catch (e) {
      // if binding lookup fails, return raw status but log error
      logger.error('internal.wireguard.enrich_bindings_error', { message: e && e.message });
      return res.json(raw);
    }
  } catch (e) {
    logger.error('internal.wireguard.status_error', { message: e && e.message });
    res.status(500).json({ ok: false, code: 'internal_error' });
  }
});

// Internal endpoints to manage peer bindings (protected)
app.post('/internal/wireguard/peers/bind', async (req, res) => {
  try {
    const { publicKey, deviceId, mikrotikIp } = req.body || {};
    if (!publicKey || !deviceId || !mikrotikIp) return res.status(400).json({ ok: false, code: 'invalid_payload', message: 'publicKey, deviceId and mikrotikIp required' });
    const binding = await peerBinding.bindPeer({ publicKey, deviceId, mikrotikIp });
    res.json({ ok: true, binding });
  } catch (e) {
    logger.error('internal.wireguard.bind_error', { message: e && e.message });
    res.status(500).json({ ok: false, code: 'internal_error' });
  }
});

app.delete('/internal/wireguard/peers/:publicKey', async (req, res) => {
  try {
    const publicKey = req.params.publicKey;
    if (!publicKey) return res.status(400).json({ ok: false, code: 'invalid_payload', message: 'publicKey required' });
    const removed = await peerBinding.unbindPeer(publicKey);
    res.json({ ok: true, removed });
  } catch (e) {
    logger.error('internal.wireguard.unbind_error', { message: e && e.message });
    res.status(500).json({ ok: false, code: 'internal_error' });
  }
});

app.get('/internal/wireguard/peers/bindings', async (req, res) => {
  try {
    const list = await peerBinding.listBindings();
    res.json({ ok: true, bindings: list });
  } catch (e) {
    logger.error('internal.wireguard.list_bindings_error', { message: e && e.message });
    res.status(500).json({ ok: false, code: 'internal_error' });
  }
});

// Internal: probe mikrotik via tunnel. Body: { publicKey, username, password }
app.post('/internal/mikrotik/probe', async (req, res) => {
  try {
    const { publicKey, username, password } = req.body || {};
    if (!publicKey || !username || !password) return res.status(400).json({ ok: false, code: 'invalid_payload', message: 'publicKey, username and password required' });

    // resolve binding
    const binding = await peerBinding.getPeerBinding(publicKey);
    if (!binding || !binding.mikrotikIp) return res.status(404).json({ ok: false, code: 'binding_not_found' });

    // probe mikrotik (do not log password)
    try {
      const probe = await mikrotikProbe.probeMikrotik({ ip: binding.mikrotikIp, username, password });
      // include deviceId from binding
      return res.json({ ok: true, deviceId: binding.deviceId, identity: probe.identity || null, version: probe.version || null, board: probe.board || null });
    } catch (err) {
      const code = err && err.code ? err.code : 'probe_failed';
      logger.info('internal.mikrotik.probe_error', { publicKey, deviceId: binding.deviceId, code, message: err && err.message });
      return res.status(502).json({ ok: false, code, message: err && err.message });
    }
  } catch (e) {
    logger.error('internal.mikrotik.probe_unhandled', { message: e && e.message });
    return res.status(500).json({ ok: false, code: 'internal_error' });
  }
});

const redisOk = await assertRedisReady();
if (!redisOk && REDIS_REQUIRED) {
  logger.error("fatal.redis_required_unavailable");
  process.exit(1);
}

app.listen(PORT, process.env.BIND_HOST || "127.0.0.1", async () => {
  logger.info('relay.online', { port: PORT, host: process.env.BIND_HOST || "127.0.0.1" });
  logger.info("relay.boot", {
    port: process.env.PORT,
    redis: process.env.REDIS_HOST,
    env: process.env.NODE_ENV
  });
  try {
    getPrisma();
    const tenant = await ensureDefaultTenant();
    if (tenant) {
      logger.info("tenant.default_ready", { id: tenant.id, slug: tenant.slug });
    } else {
      logger.warn("tenant.default_unavailable");
    }
  } catch (e) {
    logger.error("tenant.default_bootstrap_failed", { message: e && e.message });
  }

  // Start background event consumer and job runner
  try {
    const consumer = new EventConsumer();
    consumer.start();
    if (JOB_RUNNER_ENABLED) {
      logger.info("jobRunner.starting");
      jobRunner.startJobRunner();
    } else {
      logger.info("jobRunner.disabled");
    }
    sessionCleaner.startSessionCleaner();
    activeSessionMonitor.startActiveSessionMonitor();
    reconciler.start();
  } catch (e) {
    logger.error('failed to start background services', e && e.message);
    // fail-fast on background startup failure
    process.exit(1);
  }
});
