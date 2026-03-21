# Dashboard Grafana — Relay Cérebro

## Importar no Grafana Cloud

1. Grafana → Dashboards → Import
2. Upload do arquivo `relay-overview.json`
3. Selecionar datasource Prometheus
4. Configurar o datasource para scrape do `/metrics`:

   URL: https://seu-relay.railway.app/metrics
   Headers: X-Metrics-Token = `<METRICS_TOKEN>`
   Intervalo: 15s

## Alertas recomendados

| Condição | Threshold | Ação |
|---|---|---|
| circuit_breaker_state == 1 | por 2 min | Slack #ops |
| relay_authorization_duration_seconds{p99} > 2s | por 5 min | PagerDuty |
| relay_active_sessions == 0 | por 10 min (horário comercial) | Slack #ops |
