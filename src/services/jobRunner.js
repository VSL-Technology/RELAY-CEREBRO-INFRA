// src/services/jobRunner.js
import jobStore from "./jobStore.js";
import { processEvent } from "./stateMachine.js";
import { executeAction } from "./actionHandler.js";
import audit from "./audit.js";
import metrics from "./metrics.js";
import identityService from "./identityService.js";
import { jobDuration, jobLockSkipped } from "../lib/metrics.js";

const TICK_MS = 5000;
const DEFAULT_LOCK_TTL_MS = parseInt(process.env.RELAY_LOCK_TTL_MS || '30000', 10);
const LOCK_HEARTBEAT_INTERVAL_MS = Math.max(
  1000,
  parseInt(process.env.RELAY_LOCK_HEARTBEAT_INTERVAL_MS || String(Math.floor(DEFAULT_LOCK_TTL_MS / 2)), 10)
);

let _timer = null;

async function runDueJobs() {
  const now = Date.now();
  const due = await jobStore.getDueJobs(now);
  if (!due || due.length === 0) return;
  for (const job of due) {
    const jobName = job.type || "unknown";

    try {
      console.log(`[jobRunner] executing job ${job.id} type=${job.type}`);

      // Keep the lock alive while the job is running to prevent duplicate execution
      // when a valid job exceeds the initial TTL.
      const lockToken = await jobStore.acquireLock(job.id, DEFAULT_LOCK_TTL_MS);
      if (!lockToken) {
        jobLockSkipped.inc({ job_name: jobName });
        console.log(`[jobRunner] could not acquire lock for ${job.id}, skipping`);
        continue;
      }
      let lockHeartbeat = null;
      if (LOCK_HEARTBEAT_INTERVAL_MS > 0) {
        lockHeartbeat = setInterval(() => {
          jobStore.extendLock(job.id, lockToken, DEFAULT_LOCK_TTL_MS).catch((error) => {
            console.error("[jobRunner] lock heartbeat error", job.id, error && error.message);
          });
        }, LOCK_HEARTBEAT_INTERVAL_MS);
        if (typeof lockHeartbeat.unref === "function") {
          lockHeartbeat.unref();
        }
      }

      try {
        const jobStart = Date.now();
        let jobStatus = "success";

        try {
          if (job.type === "REVOKE_TRIAL") {
          // call revoke action
            const payload = job.payload || {};
            const res = await executeAction({ action: "REVOKE_SESSION", payload: { mikId: payload.mikId, mac: payload.mac }, source: "job" });
            await audit.auditAttempt({ jobId: job.id, type: job.type });
            if (res && res.ok) {
              await audit.auditSuccess({ jobId: job.id, type: job.type, result: res });
              await jobStore.markJobAsProcessed(job.id);
              metrics.inc("job.revoke_success");
            } else {
              jobStatus = "failure";
              await audit.auditFail({ jobId: job.id, type: job.type, error: res && res.error });
              // increment attempts and reschedule with backoff
              const attempts = await jobStore.incrementJobAttempts(job.id);
              const MAX_ATTEMPTS = parseInt(process.env.RELAY_JOB_MAX_ATTEMPTS || '5', 10);
              if (attempts >= MAX_ATTEMPTS) {
                console.warn(`[jobRunner] job ${job.id} reached max attempts (${attempts}), dropping`);
                await jobStore.markJobAsProcessed(job.id);
                metrics.inc("job.revoke_giveup");
              } else {
                const BASE = parseInt(process.env.RELAY_JOB_BACKOFF_BASE_MS || '30000', 10);
                const backoff = BASE * Math.pow(2, attempts - 1);
                const jitter = Math.floor(Math.random() * Math.min(5000, backoff));
                const next = Date.now() + backoff + jitter;
                await jobStore.rescheduleJob(job.id, next);
                metrics.inc("job.revoke_failed");
              }
            }
          } else if (job.type === "RETRY_EVENT") {
            const ev = job.event;
            if (ev) {
              await processEvent(ev);
            }
            await jobStore.markJobAsProcessed(job.id);
          } else if (job.type === "AUTHORIZE_PENDING") {
            const payload = job.payload || {};
            await audit.auditAttempt({ jobId: job.id, type: job.type });
            const res = await identityService.retryAuthorizePending(payload);
            if (res && res.ok && res.authorized) {
              await audit.auditSuccess({ jobId: job.id, type: job.type, result: res });
              await jobStore.markJobAsProcessed(job.id);
              metrics.inc("job.authorize_success");
            } else if (res && res.pending_authorization) {
              await audit.auditSuccess({ jobId: job.id, type: job.type, result: res });
              await jobStore.markJobAsProcessed(job.id);
              metrics.inc("job.authorize_rescheduled");
            } else {
              jobStatus = "failure";
              await audit.auditFail({ jobId: job.id, type: job.type, error: res && res.code });
              await jobStore.markJobAsProcessed(job.id);
              metrics.inc("job.authorize_failed");
            }
          } else {
            jobStatus = "failure";
            console.warn("[jobRunner] unknown job type", job.type);
            await jobStore.markJobAsProcessed(job.id);
          }
        } catch (error) {
          jobStatus = "failure";
          throw error;
        } finally {
          jobDuration.observe(
            { job_name: jobName, status: jobStatus },
            (Date.now() - jobStart) / 1000
          );
        }
      } finally {
        if (lockHeartbeat) clearInterval(lockHeartbeat);
        await jobStore.releaseLock(job.id, lockToken);
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
