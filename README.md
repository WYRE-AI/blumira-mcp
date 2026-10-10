# Blumira MCP Server

[![Build Status](https://github.com/WYRE-AI/blumira-mcp/actions/workflows/release.yml/badge.svg)](https://github.com/WYRE-AI/blumira-mcp/actions/workflows/release.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that provides AI assistants with structured access to [Blumira](https://blumira.com) SIEM platform data and operations.

> **Note:** This project is maintained by [Wyre Technology](https://github.com/WYRE-AI).

## Quick Start

**Claude Desktop** — download, open, done:

1. Download `blumira-mcp.mcpb` from the [latest release](https://github.com/WYRE-AI/blumira-mcp/releases/latest)
2. Open the file (double-click or drag into Claude Desktop)
3. Enter your Blumira JWT token when prompted

No terminal, no JSON editing, no Node.js install required.

**Claude Code (CLI):**

```bash
claude mcp add blumira-mcp \
  -e BLUMIRA_JWT_TOKEN=your-jwt-token \
  -- npx -y github:WYRE-AI/blumira-mcp
```

See [Installation](#installation) for Docker and from-source methods.

## Features

- **🔌 MCP Protocol Compliance**: Full support for MCP resources and tools
- **🛡️ Comprehensive SIEM Coverage**: Tools spanning findings, agents/devices, users, resolutions, and MSP account management
- **🔍 Decision-Tree Navigation**: Start with `blumira_navigate` to explore domains, then dynamically load domain-specific tools
- **🏢 MSP Multi-Tenant Support**: Full MSP endpoint coverage for managing findings, agents, and users across accounts
- **🔒 Secure Authentication**: JWT token or API key (`pax8ApiTokenV1`) authentication
- **🌐 Dual Transport**: Supports both stdio (local) and HTTP Streamable (remote/Docker) transports
- **📦 MCPB Packaging**: One-click installation via MCP Bundle for desktop clients
- **🐳 Docker Ready**: Containerized deployment with HTTP transport and health checks
- **⚡ Rate Limiting**: Built-in rate limiter respects Blumira API limits
- **🔎 Rich Filtering**: Support for `.eq`, `.in`, `.gt`, `.lt`, `.contains`, `.regex`, and negation operators

## Installation

### Option 1: MCPB Bundle (Claude Desktop)

The simplest method — no terminal, no JSON editing, no Node.js install required.

1. Download `blumira-mcp.mcpb` from the [latest release](https://github.com/WYRE-AI/blumira-mcp/releases/latest)
2. Open the file (double-click or drag into Claude Desktop)
3. Enter your Blumira JWT token when prompted

For **Claude Code (CLI)**, one command:

```bash
claude mcp add blumira-mcp \
  -e BLUMIRA_JWT_TOKEN=your-jwt-token \
  -- npx -y github:WYRE-AI/blumira-mcp
```

### Option 2: Docker

```bash
docker compose up
```

Compose will not start until `CONDUIT_S2S_SECRET` is set. See [Docker Deployment](#docker-deployment).

Or pull the pre-built image:

```bash
# Generate the secret first: openssl rand -hex 32
docker run -d \
  -e CONDUIT_S2S_SECRET \
  -e BLUMIRA_JWT_TOKEN \
  -e AUTH_MODE=env \
  -p 127.0.0.1:8080:8080 \
  ghcr.io/wyre-ai/blumira-mcp:latest
```

The image defaults to `AUTH_MODE=gateway` and binds `0.0.0.0` inside the container. HTTP startup refuses to run unless `CONDUIT_S2S_SECRET` is a real secret (empty values and known placeholders such as `replace-with-a-real-secret` exit non-zero). Publish the port on `127.0.0.1` (as above). In gateway mode, send vendor credentials on each `/mcp` request (`X-Blumira-Client-ID` + `X-Blumira-Client-Secret`, or `X-Blumira-JWT-Token`); the server does not fall back to environment credentials. Set `AUTH_MODE=env` only for a single-tenant container that should use `BLUMIRA_JWT_TOKEN`.

Every `/mcp` request must also send `X-Gateway-S2S`. The check is `verifyS2sHeader` in [`src/s2s-verify.ts`](src/s2s-verify.ts): the header value is `t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 of the literal string `t=<unix seconds>` keyed with `CONDUIT_S2S_SECRET` (64 lowercase hex characters). The timestamp must be within 300 seconds of the server clock. A missing or invalid header is HTTP 401, before vendor credentials are read.

```bash
TS=$(date +%s)
SIG=$(printf 't=%s' "$TS" | openssl dgst -sha256 -hmac "$CONDUIT_S2S_SECRET" -hex | awk '{print $NF}')
curl -sS http://127.0.0.1:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "X-Gateway-S2S: t=${TS},v1=${SIG}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

With `AUTH_MODE=env`, that signed request uses `BLUMIRA_JWT_TOKEN` from the container. With `AUTH_MODE=gateway`, add `X-Blumira-JWT-Token` or `X-Blumira-Client-ID` and `X-Blumira-Client-Secret` as well.

Standalone local use that cannot sign requests: set `MCP_ALLOW_INSECURE_DEV=1` and do not set `CONDUIT_S2S_SECRET`. Startup logs a warning, skips the S2S check, and binds `127.0.0.1` only. The image sets `MCP_HTTP_HOST=0.0.0.0`, so this bypass also requires `-e MCP_HTTP_HOST=127.0.0.1`. Any other bind address refuses to start. Do not publish that port off loopback.

### Option 3: From Source

```bash
git clone https://github.com/WYRE-AI/blumira-mcp.git
cd blumira-mcp
npm ci
npm run build
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `BLUMIRA_JWT_TOKEN` | JWT token for authentication (stdio and `AUTH_MODE=env`) | — |
| `MCP_TRANSPORT` | Transport mode (`stdio` or `http`) | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `8080` |
| `MCP_HTTP_HOST` | Interface the HTTP server binds | `127.0.0.1` |
| `CONDUIT_S2S_SECRET` | Required for HTTP. HMAC secret checked against `X-Gateway-S2S` on `/mcp`. Generate with `openssl rand -hex 32`. If empty or a known placeholder, the HTTP server logs an error and exits non-zero. The value is never logged. | — |
| `MCP_ALLOW_INSECURE_DEV` | Set to `1` to start HTTP without `CONDUIT_S2S_SECRET`. Logs a warning, does not enforce S2S, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` refuses to start. Local development only. | unset |
| `AUTH_MODE` | `env` uses process environment credentials (stdio and single-tenant HTTP). `gateway` requires per-request vendor headers and never falls back to the environment. The Docker image and Compose file default to `gateway`. | `env` when unset; `gateway` in Docker and Compose |
| `LOG_LEVEL` | Log level (`debug`, `info`, `warn`, `error`) | `info` |

`/health` and `/healthz` stay unauthenticated and do not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

## Domains

The server uses decision-tree navigation. Start with `blumira_navigate` to pick a domain:

| Domain | Tools |
|--------|-------|
| **findings** | List findings, get finding, get finding details, resolve finding, assign owners, list/add comments |
| **agents** | List devices, get device, list agent keys, get agent key |
| **users** | List users |
| **resolutions** | List available resolutions |
| **msp** | List/get accounts, list/get/resolve findings, assign owners, comments, list devices/keys, list users |

## Filtering

Blumira supports rich query filtering on list endpoints:

```
status.eq=10              # Exact match
severity.in=HIGH,CRITICAL # Multiple values
created_at.gt=2026-01-01  # Greater than
name.contains=malware     # Substring match
!status.eq=30             # Negation
```

Pass filters as tool input parameters — the server handles query string construction.

## Docker Deployment

Copy `.env.example` to `.env` and fill in your credentials, including `CONDUIT_S2S_SECRET`. Compose will not start if that variable is missing, and it publishes the HTTP port on `127.0.0.1` only.

```bash
cp .env.example .env
# Edit .env with your Blumira JWT token and CONDUIT_S2S_SECRET
docker compose up -d
```

## Development

```bash
npm ci
npm run build       # Build the project
npm run dev         # Watch mode
npm run test        # Run tests
npm run lint        # Type-check
npm run clean       # Remove dist/
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

Apache 2.0 — Copyright WYRE Technology
