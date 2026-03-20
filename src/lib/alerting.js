import logger from "../services/logger.js";

export async function sendAlert(event) {
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;

  const payload = {
    text: formatAlert(event),
    ...event
  };

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000)
    });
  } catch (err) {
    logger.warn("alert_send_failed", {
      message: err && err.message ? err.message : String(err)
    });
  }
}

function formatAlert(event) {
  switch (event.type) {
    case "circuit_breaker_opened":
      return `ALERTA: Roteador ${event.router_id} com falhas (${event.failures} erros consecutivos)`;
    case "circuit_breaker_recovered":
      return `RECUPERADO: Roteador ${event.router_id} voltou a responder`;
    case "job_failed":
      return `FALHA: Job ${event.job_name} falhou - ${event.error}`;
    case "reconciler_divergence":
      return `DIVERGENCIA: ${event.divergent} sessoes dessincronizadas entre Redis e MikroTik`;
    default:
      return JSON.stringify(event);
  }
}

