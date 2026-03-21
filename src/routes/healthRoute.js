// /health/live is liveness probe; /health/ready is readiness probe.
import { runHealthCheck } from "../health/healthService.js";

export async function healthRoute(req, res) {
  const health = await runHealthCheck();
  if (health.status === "ok") {
    return res.status(200).json({ status: "ok" });
  }
  return res.status(503).json({ status: "degraded" });
}

export async function healthReadyRoute(req, res) {
  const health = await runHealthCheck();
  if (health.status === "ok") {
    return res.status(200).json(health);
  }
  return res.status(503).json(health);
}

export function healthLiveRoute(req, res) {
  return res.status(200).json({ status: "alive" });
}

export default healthRoute;
