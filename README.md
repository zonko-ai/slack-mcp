# Slack MCP

OAuth-based Slack MCP server for MCP clients.

This repository is intentionally standalone. It provides:

- a Streamable HTTP MCP endpoint at `/mcp`
- a Cloudflare Worker-safe FastMCP Streamable HTTP transport
- MCP OAuth endpoints backed by `@cloudflare/workers-oauth-provider`
- Slack OAuth install flow for connecting arbitrary Slack workspaces
- encrypted Slack access and refresh token storage in Cloudflare D1
- Slack token rotation before access tokens expire, when token rotation is enabled on the Slack app
- stateful MCP sessions with configurable idle expiry and explicit DELETE termination
- local Node development mode with file-backed token storage
- a data-driven Slack Web API catalog covering the high-value Composio-style Slack surface

## Tool Coverage

The catalog currently exposes 96 MCP tools across:

- auth, team, profile, and emoji
- users and profiles
- conversations, history, members, and channel management
- chat send, update, delete, schedule, permalink, and unfurl
- search
- reactions
- files and remote files
- pins
- reminders
- stars
- bookmarks
- user groups
- calls
- DND
- selected Enterprise admin tools

Admin tools are exposed in the MCP catalog. MCP OAuth scopes are only a coarse connection grant; tool authorization is delegated to Slack. If the connected Slack token has the relevant `admin.*` Slack OAuth scopes and the workspace supports the Admin API, admin tools can run. Those Slack scopes are still not requested by the default OAuth scope set because many normal workspaces cannot approve Enterprise admin scopes.

## Local Node Development

```bash
npm install
npm test
npm run typecheck
npm run dev
```

Configure local Node development with `.env`:

```bash
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_REDIRECT_URI=http://127.0.0.1:13182/oauth/callback
SLACK_MCP_HOST=127.0.0.1
SLACK_MCP_PORT=13182
SLACK_MCP_ALLOWED_ORIGINS=http://127.0.0.1:13182
SLACK_MCP_API_KEY=change-me
SLACK_MCP_SESSION_TTL_SECONDS=3600
SLACK_MCP_TOKEN_STORE=.local/slack-tokens.json
SLACK_OAUTH_SCOPES=
SLACK_OAUTH_BOT_SCOPES=
SLACK_TOKEN_REFRESH_WINDOW_SECONDS=300
```

Connect Slack locally at:

```text
http://127.0.0.1:13182/oauth/start
```

Then use:

```text
http://127.0.0.1:13182/mcp
```

The local Node server requires `Authorization: Bearer <SLACK_MCP_API_KEY>` and optional multi-workspace selection with `X-Slack-Connection-Id`. MCP sessions expire after `SLACK_MCP_SESSION_TTL_SECONDS` seconds of inactivity; clients can also close them with HTTP `DELETE /mcp` and the `Mcp-Session-Id` header.

The MCP endpoint returns JSON responses for tool calls and returns HTTP 405 for standalone GET/SSE listening streams.

## Cloudflare Deployment

Cloudflare production mode is the default path:

```bash
npm run db:migrate:remote
npm run deploy
```

Cloudflare bindings:

- `DB`: D1 database containing encrypted Slack installations
- `OAUTH_KV`: KV namespace used by the MCP OAuth provider, short-lived Slack OAuth state, and short-lived MCP session records

Worker secrets:

```bash
npx wrangler secret put SLACK_CLIENT_ID --config wrangler.jsonc
npx wrangler secret put SLACK_CLIENT_SECRET --config wrangler.jsonc
npx wrangler secret put TOKEN_ENCRYPTION_KEY --config wrangler.jsonc
```

If Slack token rotation is enabled for the Slack app, the OAuth response includes refresh tokens. The MCP stores those refresh tokens encrypted and refreshes user or bot tokens within `SLACK_TOKEN_REFRESH_WINDOW_SECONDS` before expiry.

Cloudflare MCP sessions use `SLACK_MCP_SESSION_TTL_SECONDS` as an idle TTL. The default is `3600`.

Generate `TOKEN_ENCRYPTION_KEY` as a 32-byte key:

```bash
openssl rand -base64 32
```

Set the Slack app redirect URL to:

```text
https://<worker-host>/slack/oauth/callback
```

The deployed MCP OAuth surface is:

```text
https://<worker-host>/mcp
https://<worker-host>/authorize
https://<worker-host>/token
https://<worker-host>/register
```

## Tests

```bash
npm test
npm run typecheck
npm run build
```

Live Slack tool coverage is opt-in because it performs real Slack API calls:

```bash
npm run test:live-tools
```

For a deployed OAuth-backed Worker, pass the MCP access token and endpoint:

```bash
SLACK_MCP_TEST_ENDPOINT=https://<worker-host>/mcp \
SLACK_MCP_BEARER_TOKEN=<mcp-access-token> \
npm run test:live-tools
```

Do not commit `.env`, `.dev.vars`, `.local`, `.wrangler`, token stores, or live tool reports.
