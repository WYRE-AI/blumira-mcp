## [Unreleased]

### Fixed

- Container crashed on startup with `ERR_MODULE_NOT_FOUND: Cannot find package
  '@wyre-technology/node-blumira'`. The dependency was declared as a local
  `file:../node-blumira` path that does not exist inside the Docker build,
  so `npm ci` never installed it. Switched to the published registry version
  `^1.0.1` (`@wyre-technology/node-blumira@1.0.1` now ships its compiled
  `dist/` output; `1.0.0` did not).
- Docker `CMD` now starts the HTTP server (`dist/http.js`) when
  `MCP_TRANSPORT=http`, instead of always running the stdio entrypoint
  (`dist/index.js`). The stdio entrypoint never opens a listening socket,
  so the container exited immediately in gateway/ACA deployments and the
  liveness probe could never succeed.
- `/health` (and new `/healthz`) liveness endpoints now always return `200`
  while the process is up. Previously `/health` returned `503` when no
  env-based credentials were present, which wrongly failed the Azure
  Container Apps liveness probe in gateway mode (credentials arrive
  per-request via headers).

## [1.1.1](https://github.com/wyre-technology/blumira-mcp/compare/v1.1.0...v1.1.1) (2026-04-07)


### Bug Fixes

* **ci:** deploy :latest tag, force revision via env var bump ([8999490](https://github.com/wyre-technology/blumira-mcp/commit/8999490503309f593d346fef8906554ece850e82))

# [1.1.0](https://github.com/wyre-technology/blumira-mcp/compare/v1.0.2...v1.1.0) (2026-04-06)


### Features

* support OAuth2 client credentials in gateway mode ([52c572f](https://github.com/wyre-technology/blumira-mcp/commit/52c572f80215031986919135b1b6b297c9cd9e22))

## [1.0.2](https://github.com/wyre-technology/blumira-mcp/compare/v1.0.1...v1.0.2) (2026-02-26)


### Bug Fixes

* handle npm ls non-zero exit in pack-mcpb ([a12e850](https://github.com/wyre-technology/blumira-mcp/commit/a12e8506a3d616e3166ae737243d746e8516e07b))

## [1.0.1](https://github.com/wyre-technology/blumira-mcp/compare/v1.0.0...v1.0.1) (2026-02-26)


### Bug Fixes

* rename pack-mcpb.js to .cjs for ESM compat ([3cab34e](https://github.com/wyre-technology/blumira-mcp/commit/3cab34e0f3638bf0054042620f3bdcf177d8830a))

# 1.0.0 (2026-02-26)


### Features

* initial Blumira MCP server ([4ddb67a](https://github.com/wyre-technology/blumira-mcp/commit/4ddb67ab53e119d4ca6b9b753f3c3e5dc0a9971c))
