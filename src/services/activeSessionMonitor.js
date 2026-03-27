import logger from "./logger.js";
import sessionStore from "./sessionStore.js";
import { runMikrotikCommands } from "./mikrotik.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { extractRows, normalizeActiveRow } from "../lib/hotspotParsers.js";

const ACTIVE_SESSION_MONITOR_INTERVAL_MS = Number(process.env.ACTIVE_SESSION_MONITOR_INTERVAL_MS || 5000);
const SESSION_MONITOR_CONCURRENCY = Number(process.env.SESSION_MONITOR_CONCURRENCY || 10);
const ACTIVE_PRINT_COMMAND = "/ip/hotspot/active/print";

let activeSessionMonitorTimer = null;

function resolveRouterHost(session) {
  return String(session && (session.router || session.identity) || "").trim() || null;
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

export async function fetchActiveSessionsFromRouter(session) {
  const host = resolveRouterHost(session);
  if (!host) {
    throw new Error("session router not set");
  }

  const { user, pass, port } = getRouterCredentials();
  const result = await runMikrotikCommands({ host, user, pass, port }, [[ACTIVE_PRINT_COMMAND]]);

  if (!result.ok) {
    const message = result && result.error && result.error.message
      ? result.error.message
      : "failed to fetch hotspot active sessions";
    throw new Error(message);
  }

  return extractRows(result)
    .map((row) => normalizeActiveRow(row))
    .filter(Boolean);
}

function findMonitorSourceSession(sessions) {
  return sessions.find((session) => session && session.ip && resolveRouterHost(session)) || null;
}

function groupSessionsByRouter(sessions) {
  const groups = new Map();

  for (const session of sessions) {
    if (!session || !session.ip) continue;

    const router = resolveRouterHost(session);
    if (!router) continue;

    if (!groups.has(router)) {
      groups.set(router, []);
    }
    groups.get(router).push(session);
  }

  return groups;
}

export async function syncActiveSessions() {
  const sessions = await sessionStore.listSessions();

  logger.info("session.active.sync.start", {
    count: sessions.length
  });

  if (sessions.length === 0) {
    logger.info("session.active.sync.success", {
      count: 0,
      updated: 0
    });
    return;
  }

  const sessionsByRouter = groupSessionsByRouter(sessions);
  if (sessionsByRouter.size === 0) {
    logger.info("session.active.sync.success", {
      count: sessions.length,
      updated: 0
    });
    return;
  }

  let updated = 0;
  let failed = 0;

  for (const [router, routerSessions] of sessionsByRouter.entries()) {
    const sourceSession = findMonitorSourceSession(routerSessions);
    if (!sourceSession) continue;

    logger.info("session.monitor.router", {
      router,
      count: routerSessions.length
    });
    logger.info("session.active.sync.router.start", {
      router,
      count: routerSessions.length
    });

    let activeSessions = [];

    try {
      // eslint-disable-next-line no-await-in-loop
      activeSessions = await fetchActiveSessionsFromRouter(sourceSession);
      logger.info("session.active.sync.router.success", {
        router,
        activeCount: activeSessions.length
      });
    } catch (error) {
      logger.error("session.active.sync.router.error", {
        router,
        sessionId: sourceSession.sessionId,
        ip: sourceSession.ip,
        message: error && error.message ? error.message : String(error)
      });
      continue;
    }

    const results = await mapWithConcurrency(routerSessions, async (session) => {
      const isActive = activeSessions.some((item) => item.ip === session.ip);

      // Não confiar apenas em /hotspot/active para sessões autorizadas
      // (cliente pode estar em bypassed binding e não aparecer lá)
      if (!isActive && session.status === "authorized") {
        // Pular update quando authorized e ausente em /hotspot/active
        return { sessionId: session.sessionId };
      }

      await sessionStore.updateSession(session.sessionId, {
        active: isActive
      });

      return { sessionId: session.sessionId };
    }, SESSION_MONITOR_CONCURRENCY);

    const succeeded = results.filter((result) => result.status === "fulfilled").length;
    const failedForRouter = results.filter((result) => result.status === "rejected").length;
    updated += succeeded;
    failed += failedForRouter;

    results.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      const session = routerSessions[index];
      logger.error("session.active.sync.error", {
        sessionId: session && session.sessionId,
        ip: session && session.ip,
        router,
        message: result.reason && result.reason.message ? result.reason.message : String(result.reason)
      });
    });

    logger.info("session.active.sync.batch_processed", {
      router,
      total: routerSessions.length,
      succeeded,
      failed: failedForRouter
    });
  }

  logger.info("session.active.sync.success", {
    count: sessions.length,
    updated,
    failed
  });
}

export function startActiveSessionMonitor() {
  if (activeSessionMonitorTimer) {
    return activeSessionMonitorTimer;
  }

  activeSessionMonitorTimer = setInterval(() => {
    syncActiveSessions().catch((error) => {
      logger.error("session.active.sync.error", {
        message: error && error.message ? error.message : String(error)
      });
    });
  }, ACTIVE_SESSION_MONITOR_INTERVAL_MS);

  if (typeof activeSessionMonitorTimer.unref === "function") {
    activeSessionMonitorTimer.unref();
  }

  return activeSessionMonitorTimer;
}

export default {
  fetchActiveSessionsFromRouter,
  syncActiveSessions,
  startActiveSessionMonitor
};
