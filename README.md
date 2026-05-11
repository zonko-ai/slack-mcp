# Harbor Slack MCP

OAuth-based Slack MCP server for Harbor and other MCP clients.

This repository is intentionally standalone. It provides:

- a Streamable HTTP MCP endpoint at `/mcp`
- MCP OAuth endpoints backed by `@cloudflare/workers-oauth-provider`
- Slack OAuth install flow for connecting arbitrary Slack workspaces
- encrypted Slack token storage in Cloudflare D1
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

Admin tools are exposed in the MCP catalog but their `admin.*` Slack scopes are not requested by the default OAuth scope set. Slack requires Enterprise or org-level installs for many Admin APIs, so those should be enabled through a separate admin OAuth profile rather than silently requested from normal workspace users.

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
SLACK_MCP_TOKEN_STORE=.local/slack-tokens.json
SLACK_OAUTH_SCOPES=
SLACK_OAUTH_BOT_SCOPES=
```

Connect Slack locally at:

```text
http://127.0.0.1:13182/oauth/start
```

Then use:

```text
http://127.0.0.1:13182/mcp
```

The local Node server supports `Authorization: Bearer <SLACK_MCP_API_KEY>` and optional multi-workspace selection with `X-Slack-Connection-Id`.

## Cloudflare Deployment

Cloudflare production mode is the default path for Harbor:

```bash
npm run db:migrate:remote
npm run deploy
```

Cloudflare bindings:

- `DB`: D1 database containing encrypted Slack installations
- `OAUTH_KV`: KV namespace used by the MCP OAuth provider and short-lived Slack OAuth state

Worker secrets:

```bash
npx wrangler secret put SLACK_CLIENT_ID --config wrangler.jsonc
npx wrangler secret put SLACK_CLIENT_SECRET --config wrangler.jsonc
npx wrangler secret put TOKEN_ENCRYPTION_KEY --config wrangler.jsonc
```

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

Do not commit `.env`, `.dev.vars`, `.local`, `.wrangler`, token stores, or live tool reports.
