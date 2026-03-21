import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics
} from "prom-client";

const METRICS_SINGLETON_KEY = "__relayPrometheusMetrics";

function createMetrics() {
  const register = new Registry();
  register.setDefaultLabels({ service: "relay-cerebro" });

  // Node.js runtime metrics: CPU, memory, GC, event loop.
  collectDefaultMetrics({ register });

  const authorizationDuration = new Histogram({
    name: "relay_authorization_duration_seconds",
    help: "Latencia de autorizacao de sessao (do recebimento ate ip-binding/add)",
    labelNames: ["router_id", "status"],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [register]
  });

  const authorizationTotal = new Counter({
    name: "relay_authorization_total",
    help: "Total de autorizacoes processadas",
    labelNames: ["router_id", "status"],
    registers: [register]
  });

  const activeSessions = new Gauge({
    name: "relay_active_sessions",
    help: "Sessoes com status authorized no Redis",
    labelNames: ["router_id"],
    registers: [register]
  });

  const sessionsCleaned = new Counter({
    name: "relay_sessions_cleaned_total",
    help: "Sessoes expiradas e removidas pelo sessionCleaner",
    labelNames: ["router_id", "result"],
    registers: [register]
  });

  const mikrotikCommandDuration = new Histogram({
    name: "relay_mikrotik_command_duration_seconds",
    help: "Latencia de comandos executados no MikroTik via API",
    labelNames: ["router_id", "command", "status"],
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [register]
  });

  const circuitBreakerState = new Gauge({
    name: "relay_circuit_breaker_state",
    help: "1 = OPEN (roteador com falha), 0 = CLOSED (saudavel)",
    labelNames: ["router_id"],
    registers: [register]
  });

  const jobDuration = new Histogram({
    name: "relay_job_duration_seconds",
    help: "Tempo de execucao dos jobs agendados",
    labelNames: ["job_name", "status"],
    buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
    registers: [register]
  });

  const jobLockSkipped = new Counter({
    name: "relay_job_lock_skipped_total",
    help: "Jobs pulados por nao conseguir adquirir o lock",
    labelNames: ["job_name"],
    registers: [register]
  });

  const httpRequestDuration = new Histogram({
    name: "relay_http_request_duration_seconds",
    help: "Latencia das requisicoes HTTP por rota",
    labelNames: ["method", "route", "status_code"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
    registers: [register]
  });

  const httpRequestsTotal = new Counter({
    name: "relay_http_requests_total",
    help: "Total de requisicoes HTTP",
    labelNames: ["method", "route", "status_code"],
    registers: [register]
  });

  const redisOperationDuration = new Histogram({
    name: "relay_redis_operation_duration_seconds",
    help: "Latencia de operacoes Redis criticas",
    labelNames: ["operation", "status"],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
    registers: [register]
  });

  return {
    register,
    authorizationDuration,
    authorizationTotal,
    activeSessions,
    sessionsCleaned,
    mikrotikCommandDuration,
    circuitBreakerState,
    jobDuration,
    jobLockSkipped,
    httpRequestDuration,
    httpRequestsTotal,
    redisOperationDuration
  };
}

const metrics =
  globalThis[METRICS_SINGLETON_KEY] ||
  (globalThis[METRICS_SINGLETON_KEY] = createMetrics());

export const {
  register,
  authorizationDuration,
  authorizationTotal,
  activeSessions,
  sessionsCleaned,
  mikrotikCommandDuration,
  circuitBreakerState,
  jobDuration,
  jobLockSkipped,
  httpRequestDuration,
  httpRequestsTotal,
  redisOperationDuration
} = metrics;

