# Security

Please do not report security issues publicly.

Email security reports to the repository owner with:

- the affected endpoint or tool
- reproduction steps
- whether a Slack token, OAuth code, or MCP access token may have been exposed

This server stores Slack access and refresh tokens encrypted at rest in D1. MCP session records are short-lived KV records keyed by random session ids and do not contain Slack tokens. Do not commit `.env`, `.dev.vars`, `.local`, Wrangler state, or live test reports.
