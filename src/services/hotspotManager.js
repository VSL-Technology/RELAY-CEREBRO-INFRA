import logger from "./logger.js";
import { runMikrotikCommands } from "./mikrotik.js";
import { extractRows } from "../lib/hotspotParsers.js";

const PRINT_BINDING_COMMAND = "/ip/hotspot/ip-binding/print";
const ADD_BINDING_COMMAND = "/ip/hotspot/ip-binding/add";
const REMOVE_BINDING_COMMAND = "/ip/hotspot/ip-binding/remove";
const PRINT_ACTIVE_COMMAND = "/ip/hotspot/active/print";
const REMOVE_ACTIVE_COMMAND = "/ip/hotspot/active/remove";

function resolveRouterHost(session) {
  const routerId = String(session && (session.router || session.identity) || "").trim() || null;
  if (!routerId) return null;
  // Try to resolve router ID to host via MIKROTIK_NODES
  try {
    const raw = process.env.MIKROTIK_NODES;
    if (raw) {
      const nodes = JSON.parse(raw);
      const node = nodes.find(n => n.id === routerId);
      if (node && node.host) return node.host;
    }
  } catch (_) {}
  // Fallback: use routerId directly as host (for backward compat)
  return routerId;
}

function getRouterCredentials() {
  const user = String(process.env.MIKROTIK_USER || "").trim();
  const pass = String(process.env.MIKROTIK_PASS || "").trim();
  const port = Number(process.env.MIKROTIK_PORT || 8728);

  if (!user || !pass) {
    throw new Error("MIKROTIK_USER / MIKROTIK_PASS not set");
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("MIKROTIK_PORT invalid");
  }

  return { user, pass, port };
}

function sanitizeComment(value) {
  return String(value || "")
    .replace(/"/g, "")
    .replace(/[^\w:./ -]/g, "-")
    .trim();
}

function createExecError(message, command) {
  const error = new Error(message);
  error.command = command;
  return error;
}

function buildPrintBindingSentence(ip) {
  return [
    PRINT_BINDING_COMMAND,
    `?address=${ip}`
  ];
}

function buildAddBindingSentence(session) {
  const comment = sanitizeComment(session.sessionId);
  return [
    ADD_BINDING_COMMAND,
    `=address=${session.ip}`,
    "=type=bypassed",
    `=comment=${comment}`
  ];
}

function buildRemoveBindingSentence(bindingId) {
  return [
    REMOVE_BINDING_COMMAND,
    `=.id=${bindingId}`
  ];
}

function buildPrintActiveSentence(ip) {
  return [
    PRINT_ACTIVE_COMMAND,
    `?address=${ip}`
  ];
}

function buildRemoveActiveSentence(activeId) {
  return [
    REMOVE_ACTIVE_COMMAND,
    `=.id=${activeId}`
  ];
}

function findBindingByIp(result, ip) {
  return extractRows(result).find((row) => {
    const address = String(row.address || row["=address"] || "").trim();
    return address === ip;
  }) || null;
}

function findActiveByIp(result, ip) {
  return extractRows(result).find((row) => {
    const address = String(row.address || row["=address"] || "").trim();
    return address === ip;
  }) || null;
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

async function executeRouterCommand(session, sentences) {
  const host = resolveRouterHost(session);
  if (!host) {
    throw new Error("session router not set");
  }

  const { user, pass, port } = getRouterCredentials();
  return runMikrotikCommands({ host, user, pass, port }, sentences);
}

export async function authorizeSessionOnRouter(session) {
  if (!session || !session.sessionId || !session.ip) {
    throw new Error("session sessionId/ip required");
  }

  const router = resolveRouterHost(session);
  const printCommand = PRINT_BINDING_COMMAND;
  const addCommand = ADD_BINDING_COMMAND;

  logger.info("session.exec.start", {
    sessionId: session.sessionId,
    ip: session.ip,
    mac: session.mac || null,
    router,
    command: addCommand
  });

  const printResult = await executeRouterCommand(session, [buildPrintBindingSentence(session.ip)]);
  if (!printResult.ok) {
    throw createExecError(
      getResultMessage(printResult, "failed to inspect hotspot bindings"),
      printCommand
    );
  }

  const existing = extractRows(printResult).find((row) => {
    const address = String(row.address || row["=address"] || "").trim();
    const type = String(row.type || row["=type"] || "").trim().toLowerCase();
    return address === session.ip && type === "bypassed";
  }) || null;

  if (existing) {
    logger.info("session.exec.already", {
      sessionId: session.sessionId,
      ip: session.ip,
      mac: session.mac || null,
      router,
      command: printCommand
    });
    return { ok: true, alreadyAuthorized: true, result: printResult };
  }

  const addResult = await executeRouterCommand(session, [buildAddBindingSentence(session)]);
  if (!addResult.ok) {
    throw createExecError(
      getResultMessage(addResult, "failed to authorize hotspot session"),
      addCommand
    );
  }

  logger.info("session.exec.success", {
    sessionId: session.sessionId,
    ip: session.ip,
    mac: session.mac || null,
    router,
    command: addCommand
  });

  return { ok: true, alreadyAuthorized: false, result: addResult };
}

export async function revokeSessionOnRouter(session) {
  if (!session || !session.sessionId || !session.ip) {
    throw new Error("session sessionId/ip required");
  }

  const router = resolveRouterHost(session);
  const printCommand = PRINT_BINDING_COMMAND;
  const removeCommand = REMOVE_BINDING_COMMAND;

  logger.info("session.revoke.start", {
    sessionId: session.sessionId,
    ip: session.ip,
    mac: session.mac || null,
    router,
    command: removeCommand
  });

  try {
    const printResult = await executeRouterCommand(session, [buildPrintBindingSentence(session.ip)]);
    if (!printResult.ok) {
      throw createExecError(
        getResultMessage(printResult, "failed to inspect hotspot bindings for revoke"),
        printCommand
      );
    }

    const binding = findBindingByIp(printResult, session.ip);
    const bindingId = String(binding && (binding[".id"] || binding["=.id"] || binding.id) || "").trim();

    if (!binding || !bindingId) {
      logger.info("session.revoke.not_found", {
        sessionId: session.sessionId,
        ip: session.ip,
        mac: session.mac || null,
        router,
        command: printCommand
      });
      return { ok: true, revoked: false, notFound: true, result: printResult };
    }

    const removeResult = await executeRouterCommand(session, [buildRemoveBindingSentence(bindingId)]);
    if (!removeResult.ok) {
      throw createExecError(
        getResultMessage(removeResult, "failed to revoke hotspot session"),
        removeCommand
      );
    }

    logger.info("session.revoke.success", {
      sessionId: session.sessionId,
      ip: session.ip,
      mac: session.mac || null,
      router,
      command: removeCommand
    });

    return { ok: true, revoked: true, result: removeResult };
  } catch (error) {
    logger.error("session.revoke.error", {
      sessionId: session.sessionId,
      ip: session.ip,
      mac: session.mac || null,
      router,
      command: error && error.command ? error.command : removeCommand,
      message: error && error.message ? error.message : String(error)
    });
    throw error;
  }
}

export async function kickSession(session) {
  if (!session || !session.sessionId || !session.ip) {
    throw new Error("session sessionId/ip required");
  }

  const router = resolveRouterHost(session);
  const printCommand = PRINT_ACTIVE_COMMAND;
  const removeCommand = REMOVE_ACTIVE_COMMAND;

  logger.info("session.kick.start", {
    sessionId: session.sessionId,
    ip: session.ip,
    mac: session.mac || null,
    router,
    command: removeCommand
  });

  try {
    const printResult = await executeRouterCommand(session, [buildPrintActiveSentence(session.ip)]);
    if (!printResult.ok) {
      throw createExecError(
        getResultMessage(printResult, "failed to inspect hotspot active sessions"),
        printCommand
      );
    }

    const activeSession = findActiveByIp(printResult, session.ip);
    const activeId = String(activeSession && (activeSession[".id"] || activeSession["=.id"] || activeSession.id) || "").trim();

    if (!activeSession || !activeId) {
      logger.info("session.kick.not_found", {
        sessionId: session.sessionId,
        ip: session.ip,
        mac: session.mac || null,
        router,
        command: printCommand
      });
      return { ok: true, kicked: false, notFound: true, result: printResult };
    }

    const removeResult = await executeRouterCommand(session, [buildRemoveActiveSentence(activeId)]);
    if (!removeResult.ok) {
      throw createExecError(
        getResultMessage(removeResult, "failed to kick hotspot active session"),
        removeCommand
      );
    }

    logger.info("session.kick.success", {
      sessionId: session.sessionId,
      ip: session.ip,
      mac: session.mac || null,
      router,
      command: removeCommand
    });

    return { ok: true, kicked: true, result: removeResult };
  } catch (error) {
    logger.error("session.kick.error", {
      sessionId: session.sessionId,
      ip: session.ip,
      mac: session.mac || null,
      router,
      command: error && error.command ? error.command : removeCommand,
      message: error && error.message ? error.message : String(error)
    });
    throw error;
  }
}

export default {
  authorizeSessionOnRouter,
  addBinding: authorizeSessionOnRouter,
  revokeSessionOnRouter,
  removeBinding: revokeSessionOnRouter,
  kickSession
};
