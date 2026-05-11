# Security

Please do not report security issues publicly.

Email security reports to the repository owner with:

- the affected endpoint or tool
- reproduction steps
- whether a Slack token, OAuth code, or MCP access token may have been exposed

This server stores Slack tokens encrypted at rest in D1. Do not commit `.env`, `.dev.vars`, `.local`, Wrangler state, or live test reports.
