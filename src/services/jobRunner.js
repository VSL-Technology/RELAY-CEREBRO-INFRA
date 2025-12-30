// src/services/jobRunner.js
import jobStore from "./jobStore.js";
import { processEvent } from "./stateMachine.js";
import { executeAction } from "./actionHandler.js";
import audit from "./audit.js";
import metrics from "./metrics.js";
import identityService from "./identityService.js";

const TICK_MS = 5000;

let _timer = null;

async function runDueJobs() {
  const now = Date.now();
  const due = await jobStore.getDueJobs(now);
  if (!due || due.length === 0) return;
  for (const job of due) {
    try {
      console.log(`[jobRunner] executing job ${job.id} type=${job.type}`);

      // Acquire per-job lock to avoid duplicate execution across instances
      const LOCK_TTL = parseInt(process.env.RELAY_LOCK_TTL_MS || '30000', 10);
      const locked = await jobStore.acquireLock(job.id, LOCK_TTL);
      if (!locked) {
        console.log(`[jobRunner] could not acquire lock for ${job.id}, skipping`);
        continue;
      }

      if (job.type === "REVOKE_TRIAL") {
        // call revoke action
        const payload = job.payload || {};
        const res = await executeAction({ action: "REVOKE_SESSION", payload: { mikId: payload.mikId, mac: payload.mac }, source: "job" });
        await audit.auditAttempt({ jobId: job.id, type: job.type });
        if (res && res.ok) {
          await audit.auditSuccess({ jobId: job.id, type: job.type, result: res });
          await jobStore.markJobAsProcessed(job.id);
          metrics.inc("job.revoke_success");
          await jobStore.releaseLock(job.id);
        } else {
          await audit.auditFail({ jobId: job.id, type: job.type, error: res && res.error });
          // increment attempts and reschedule with backoff
          const attempts = await jobStore.incrementJobAttempts(job.id);
          const MAX_ATTEMPTS = parseInt(process.env.RELAY_JOB_MAX_ATTEMPTS || '5', 10);
          if (attempts >= MAX_ATTEMPTS) {
            console.warn(`[jobRunner] job ${job.id} reached max attempts (${attempts}), dropping`);
            await jobStore.markJobAsProcessed(job.id);
            await jobStore.releaseLock(job.id);
            metrics.inc("job.revoke_giveup");
          } else {
            // exponential backoff with jitter
            const BASE = parseInt(process.env.RELAY_JOB_BACKOFF_BASE_MS || '30000', 10);
            const backoff = BASE * Math.pow(2, attempts - 1);
            const jitter = Math.floor(Math.random() * Math.min(5000, backoff));
            const next = Date.now() + backoff + jitter;
            await jobStore.rescheduleJob(job.id, next);
            await jobStore.releaseLock(job.id);
            metrics.inc("job.revoke_failed");
          }
        }
      } else if (job.type === "RETRY_EVENT") {
        // re-run original event processing
        const ev = job.event;
        if (ev) {
          await processEvent(ev);
        }
        await jobStore.markJobAsProcessed(job.id);
        await jobStore.releaseLock(job.id);
      } else if (job.type === "AUTHORIZE_PENDING") {
        const payload = job.payload || {};
        await audit.auditAttempt({ jobId: job.id, type: job.type });
        const res = await identityService.retryAuthorizePending(payload);
        if (res && res.ok && res.authorized) {
          await audit.auditSuccess({ jobId: job.id, type: job.type, result: res });
          await jobStore.markJobAsProcessed(job.id);
          metrics.inc("job.authorize_success");
          await jobStore.releaseLock(job.id);
        } else if (res && res.pending_authorization) {
          // already rescheduled inside retryAuthorizePending; drop this job
          await audit.auditSuccess({ jobId: job.id, type: job.type, result: res });
          await jobStore.markJobAsProcessed(job.id);
          await jobStore.releaseLock(job.id);
          metrics.inc("job.authorize_rescheduled");
        } else {
          await audit.auditFail({ jobId: job.id, type: job.type, error: res && res.code });
          await jobStore.markJobAsProcessed(job.id);
          await jobStore.releaseLock(job.id);
          metrics.inc("job.authorize_failed");
        }
      } else {
        console.warn("[jobRunner] unknown job type", job.type);
        await jobStore.markJobAsProcessed(job.id);
        await jobStore.releaseLock(job.id);
      }
    } catch (e) {
      console.error("[jobRunner] job execution error", e.message);
      // avoid tight loop: remove job and create retry
      const retry = { ...job, id: job.id + "-retry", runAt: Date.now() + 30000 };
      await jobStore.addJob(retry);
      await jobStore.markJobAsProcessed(job.id);
      try { await jobStore.releaseLock(job.id); } catch (_) {}
    }
  }
}

export function startJobRunner() {
  if (_timer) return;
  _timer = setInterval(() => runDueJobs(), TICK_MS);
  console.log("[jobRunner] started");
}

export function stopJobRunner() {
  if (!_timer) return;
  clearInterval(_timer);
  _timer = null;
}

export default { startJobRunner, stopJobRunner };
