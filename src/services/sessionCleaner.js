import logger from "./logger.js";
import sessionStore from "./sessionStore.js";
import hotspotManager from "./hotspotManager.js";
import { mapWithConcurrency } from "../lib/concurrency.js";

const SESSION_CLEANER_INTERVAL_MS = Number(process.env.SESSION_CLEANER_INTERVAL_MS || 10000);
const SESSION_CLEANER_CONCURRENCY = Number(process.env.SESSION_CLEANER_CONCURRENCY || 20);

let cleanerTimer = null;

async function processExpiredSession(session) {
  try {
    await hotspotManager.kickSession(session);
    logger.info("session.expire.kick", {
      sessionId: session.sessionId,
      ip: session.ip,
      mac: session.mac || null,
      router: session.router || session.identity || null,
      result: "attempted"
    });
  } catch (error) {
    logger.error("session.expire.kick", {
      sessionId: session.sessionId,
      ip: session.ip,
      mac: session.mac || null,
      router: session.router || session.identity || null,
      message: error && error.message ? error.message : String(error)
    });
  }

  try {
    await hotspotManager.revokeSessionOnRouter(session);
    logger.info("session.expire.revoke", {
      sessionId: session.sessionId,
      ip: session.ip,
      mac: session.mac || null,
      router: session.router || session.identity || null,
      result: "attempted"
    });

    await sessionStore.updateSession(session.sessionId, {
      status: "expired",
      active: false
    });
    logger.info("session.expired", {
      sessionId: session.sessionId,
      ip: session.ip,
      router: session.router || session.identity || null
    });
  } catch (error) {
    logger.error("session.expire.revoke", {
      sessionId: session.sessionId,
      ip: session.ip,
      mac: session.mac || null,
      router: session.router || session.identity || null,
      message: error && error.message ? error.message : String(error)
    });
    logger.error("session.cleaner.error", {
      sessionId: session.sessionId,
      ip: session.ip,
      mac: session.mac || null,
      router: session.router || session.identity || null,
      message: error && error.message ? error.message : String(error),
      retry: true
    });
  }
}

async function runSessionCleanerTick() {
  const now = Date.now();
  const sessions = await sessionStore.listSessions();
  const expiredSessions = [];

  for (const session of sessions) {
    if (!session) continue;
    if (session.status !== "authorized") continue;
    if (!Number.isFinite(session.expiresAt)) continue;
    if (session.expiresAt >= now) continue;
    expiredSessions.push(session);
  }

  const results = await mapWithConcurrency(expiredSessions, async (session) => {
    await processExpiredSession(session);
  }, SESSION_CLEANER_CONCURRENCY);

  logger.info("session.cleaner.batch_processed", {
    total: expiredSessions.length,
    succeeded: results.filter((result) => result.status === "fulfilled").length,
    failed: results.filter((result) => result.status === "rejected").length
  });
}

export function startSessionCleaner() {
  if (cleanerTimer) {
    return cleanerTimer;
  }

  cleanerTimer = setInterval(() => {
    runSessionCleanerTick().catch((error) => {
      logger.error("session.cleaner.tick_error", {
        message: error && error.message ? error.message : String(error)
      });
    });
  }, SESSION_CLEANER_INTERVAL_MS);

  if (typeof cleanerTimer.unref === "function") {
    cleanerTimer.unref();
  }

  logger.info("session.cleaner.started", {
    intervalMs: SESSION_CLEANER_INTERVAL_MS,
    concurrency: SESSION_CLEANER_CONCURRENCY
  });

  return cleanerTimer;
}

export default {
  startSessionCleaner
};
