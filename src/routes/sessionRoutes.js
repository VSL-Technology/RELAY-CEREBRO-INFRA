import express from "express";
import logger from "../services/logger.js";
import sessionStore from "../services/sessionStore.js";
import { buildSentence } from "../lib/buildSentence.js";
import { isValidIp, isValidMac, normalizeMac } from "../lib/validators.js";
import {
  authorizationDuration,
  authorizationTotal
} from "../lib/metrics.js";

const router = express.Router();
const PRINT_BINDING_COMMAND = "/ip/hotspot/ip-binding/print";
const REMOVE_BINDING_COMMAND = "/ip/hotspot/ip-binding/remove";
const ADD_BINDING_COMMAND = "/ip/hotspot/ip-binding/add";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveRouterHost(session) {
  const routerId = String(session && (session.router || session.identity) || "").trim() || null;
  if (!routerId) return null;
  try {
    const raw = process.env.MIKROTIK_NODES;
    if (raw) {
      const nodes = JSON.parse(raw);
      const node = nodes.find(n => n.id === routerId);
      if (node && node.host) return node.host;
    }
  } catch (_) {}
  return routerId;
}

function getRouterConfig(session) {
  const host = resolveRouterHost(session);
  const user = String(process.env.MIKROTIK_USER || "").trim();
  const pass = String(process.env.MIKROTIK_PASS || "").trim();
  const port = Number(process.env.MIKROTIK_PORT || 8728);

  if (!host || !user || !pass || !Number.isInteger(port) || port <= 0) {
    throw new Error("mikrotik_config_invalid");
  }

  return { host, user, pass, port };
}

function collectRows(result) {
  const rows = [];
  const sources = [];

  if (Array.isArray(result)) {
    sources.push(...result);
  } else if (result) {
    if (Array.isArray(result.results)) sources.push(...result.results);
    if (Array.isArray(result.data)) sources.push(...result.data);
  }

  for (const item of sources) {
    if (!item) continue;

    if (Array.isArray(item)) {
      for (const row of item) {
        if (row && typeof row === "object") rows.push(row);
      }
      continue;
    }

    if (typeof item !== "object") continue;

    if (Array.isArray(item.data)) {
      for (const row of item.data) {
        if (row && typeof row === "object") rows.push(row);
      }
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

function getResultMessage(result, fallback) {
  if (result && result.error && result.error.message) {
    return result.error.message;
  }

  if (result && Array.isArray(result.results)) {
    const failed = result.results.find((item) => item && item.ok === false);
    if (failed && failed.error) {
      return String(failed.error);
    }
  }

  return fallback;
}

function findBindingIdByIp(result, ip) {
  const match = collectRows(result).find((row) => {
    const address = String(row.address || row["=address"] || "").trim();
    return address === ip;
  }) || null;

  if (!match) return null;
  return String(match[".id"] || match["=.id"] || match.id || "").trim() || null;
}

async function addHotspotBinding(session) {
  const mik = getRouterConfig(session);
  const sentence = buildSentence(ADD_BINDING_COMMAND, {
    address: session.ip,
    type: "bypassed",
    comment: session.sessionId
  });

  const { runMikrotikCommands } = await import("../services/mikrotik.js");
  return runMikrotikCommands(mik, [sentence]);
}

async function removeHotspotBinding(session) {
  const mik = getRouterConfig(session);
  const { runMikrotikCommands } = await import("../services/mikrotik.js");

  const printResult = await runMikrotikCommands(mik, [[PRINT_BINDING_COMMAND, `?address=${session.ip}`]]);

  if (!printResult.ok) {
    return {
      ok: false,
      step: "print",
      result: printResult
    };
  }

  const bindingId = findBindingIdByIp(printResult, session.ip);
  if (!bindingId) {
    return {
      ok: true,
      notFound: true,
      result: printResult
    };
  }

  const removeResult = await runMikrotikCommands(mik, [[REMOVE_BINDING_COMMAND, `=.id=${bindingId}`]]);
  return {
    ok: !!removeResult.ok,
    notFound: false,
    result: removeResult
  };
}

const hotspotManager = {
  addBinding: addHotspotBinding,
  removeBinding: removeHotspotBinding
};

// ============================================
// POST /session/init
// ============================================
router.post("/init", async (req, res) => {
  try {
    const body = req.body || {};
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const ip = typeof body.ip === "string" ? body.ip.trim() : "";
    const mac = typeof body.mac === "string" ? body.mac.trim() : "";
    const routerName = typeof body.router === "string" ? body.router.trim() : "";

    if (!isNonEmptyString(sessionId) || !isNonEmptyString(ip) || !isNonEmptyString(mac) || !isNonEmptyString(routerName)) {
      return res.status(400).json({
        ok: false,
        code: "invalid_payload",
        message: "ip, mac, router and sessionId are required"
      });
    }
    if (!isValidIp(ip)) {
      return res.status(400).json({ ok: false, code: "invalid_ip" });
    }
    if (!isValidMac(mac)) {
      return res.status(400).json({ ok: false, code: "invalid_mac" });
    }

    const normalizedMac = normalizeMac(mac);

    const existing = await sessionStore.getSession(sessionId);
    if (existing) {
      return res.status(409).json({
        ok: false,
        code: "session_exists"
      });
    }

    const session = await sessionStore.createSession({
      sessionId,
      ip,
      mac: normalizedMac,
      router: routerName,
      status: "pending"
    });

    logger.info("session.init", {
      sessionId: session.sessionId,
      ip: session.ip,
      mac: session.mac,
      router: session.router
    });

    return res.json({
      ok: true,
      sessionId: session.sessionId
    });
  } catch (error) {
    logger.error("session.init_error", {
      message: error && error.message ? error.message : String(error)
    });
    return res.status(500).json({ ok: false, code: "internal_error" });
  }
});

// ============================================
// POST /session/authorize
// ============================================
router.post("/authorize", async (req, res) => {
  const started = Date.now();
  let sessionId = "unknown";
  let routerId = "unknown";
  let metricsRecorded = false;

  try {
    const body = req.body || {};
    sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const tempo = Number(body.tempo);
    const plano = body.plano || null;

    if (!isNonEmptyString(sessionId) || !Number.isFinite(tempo) || tempo <= 0) {
      return res.status(400).json({
        ok: false,
        code: "invalid_payload",
        message: "sessionId and tempo required"
      });
    }

    const session = await sessionStore.getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        ok: false,
        code: "session_not_found"
      });
    }

    routerId = String(session.router || session.identity || "").trim() || "unknown";
    const expiresAt = Date.now() + tempo;
    const reqId = req.get("x-request-id") || `authorize-${Date.now()}`;

    try {
      const authResult = await sessionStore.authorizeSession(
        sessionId,
        plano,
        session.pedidoId || null,
        expiresAt,
        hotspotManager,
        reqId
      );

      const duration = (Date.now() - started) / 1000;
      authorizationDuration.observe({ router_id: routerId, status: "success" }, duration);
      authorizationTotal.inc({ router_id: routerId, status: "success" });
      metricsRecorded = true;

      if (authResult.idempotent) {
        logger.info("session.authorize.idempotent", {
          sessionId,
          reqId
        });

        return res.json({
          ok: true,
          session: authResult.session,
          idempotent: true
        });
      }

      logger.info("session.authorize.complete", {
        sessionId,
        ip: session.ip,
        mac: session.mac,
        router: routerId
      });

      return res.json({
        ok: true,
        session: authResult.session
      });
    } catch (authError) {
      const duration = (Date.now() - started) / 1000;
      authorizationDuration.observe({ router_id: routerId, status: "failure" }, duration);
      authorizationTotal.inc({ router_id: routerId, status: "failure" });
      metricsRecorded = true;

      logger.error("session.authorize.failed", {
        sessionId,
        message: authError.message,
        reqId
      });

      return res.status(500).json({
        ok: false,
        code: "authorization_failed",
        message: authError.message
      });
    }
  } catch (error) {
    if (!metricsRecorded) {
      const duration = (Date.now() - started) / 1000;
      authorizationDuration.observe({ router_id: routerId, status: "failure" }, duration);
      authorizationTotal.inc({ router_id: routerId, status: "failure" });
    }

    logger.error("session.authorize_error", {
      sessionId,
      message: error && error.message ? error.message : String(error)
    });
    return res.status(500).json({ ok: false, code: "internal_error" });
  }
});

// ============================================
// POST /session/revoke
// ============================================
router.post("/revoke", async (req, res) => {
  try {
    const body = req.body || {};
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";

    if (!isNonEmptyString(sessionId)) {
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

    const reqId = req.get("x-request-id") || `revoke-${Date.now()}`;

    try {
      const revokeResult = await sessionStore.revokeSession(
        sessionId,
        hotspotManager,
        reqId
      );

      if (revokeResult.idempotent) {
        logger.info("session.revoke.idempotent", {
          sessionId,
          reqId
        });

        return res.json({
          ok: true,
          session: revokeResult.session,
          idempotent: true
        });
      }

      logger.info("session.revoke.complete", {
        sessionId,
        ip: session.ip,
        mac: session.mac
      });

      return res.json({
        ok: true,
        session: revokeResult.session
      });
    } catch (revokeError) {
      logger.error("session.revoke.failed", {
        sessionId,
        message: revokeError.message,
        reqId
      });

      return res.status(500).json({
        ok: false,
        code: "revoke_failed",
        message: revokeError.message
      });
    }
  } catch (error) {
    logger.error("session.revoke_error", {
      message: error && error.message ? error.message : String(error)
    });
    return res.status(500).json({ ok: false, code: "internal_error" });
  }
});

// ============================================
// GET /session/:sessionId
// ============================================
router.get("/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await sessionStore.getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        ok: false,
        code: "session_not_found"
      });
    }

    return res.json({
      ok: true,
      session
    });
  } catch (error) {
    logger.error("session.get_error", {
      message: error && error.message ? error.message : String(error)
    });
    return res.status(500).json({ ok: false, code: "internal_error" });
  }
});

export default router;
