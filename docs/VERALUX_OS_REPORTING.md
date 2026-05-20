# Reporting to VeraLux OS (Solomon)

Optional. When enabled, Solomon pushes **heartbeats** and **aggregate metrics** (counts and 24h usage sums) to your VeraLux System deployment. No message bodies, transcripts, or lead contact fields are sent.

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `VERALUX_OS_REPORTING_ENABLED` | yes | Must be `true` to start reporting |
| `VERALUX_OS_URL` | yes | Base URL of VeraLux System (e.g. `https://dashboard.veralux.ai`) |
| `VERALUX_OS_API_KEY` | yes | Same value as `VERALUX_INTERNAL_API_KEY` on the OS |
| `VERALUX_DEPLOYMENT_ID` | yes | Stable id for this Solomon deployment (`[a-zA-Z0-9._-]{1,128}`) |
| `VERALUX_PRODUCT_TYPE` | no | Default `solomon` |
| `VERALUX_DEPLOYMENT_ENV` | no | Defaults `NODE_ENV` or `development` |
| `VERALUX_DEPLOYMENT_PUBLIC_URL` | no | Public URL stored on deployment row |
| `VERALUX_OS_HEARTBEAT_INTERVAL_MS` | no | Default `180000` (3 min), clamped 60s–5m |
| `VERALUX_OS_METRICS_INTERVAL_MS` | no | Default `3600000` (1h) |

## Code

Implementation: `services/veraluxOsReporter.js`, started from `server.js` after HTTP listen. Failures are logged only; they do not affect chat traffic.
