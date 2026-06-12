# Multi-stage build for efficient container size
FROM node:22-alpine AS builder

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"
ARG GITHUB_TOKEN


WORKDIR /app

COPY package*.json ./

# Install with GitHub Packages auth for @wyre-technology scope
RUN echo "@wyre-technology:registry=https://npm.pkg.github.com" > .npmrc && \
    echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> .npmrc && \
    npm ci --ignore-scripts && rm -f .npmrc

COPY . .

RUN npm run build

# Production stage
FROM node:22-alpine AS production


RUN addgroup -g 1001 -S blumira && \
    adduser -S blumira -u 1001 -G blumira

WORKDIR /app

COPY package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

RUN npm prune --omit=dev && npm cache clean --force

# Remove the bundled npm CLI from the production image (after the prune/cache
# steps above, which need it); the runtime only needs node, and npm's bundled
# dependencies trigger Trivy base-image CVE alerts.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

RUN mkdir -p /app/logs && chown -R blumira:blumira /app

USER blumira

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
ENV AUTH_MODE=env

VOLUME ["/app/logs"]

# Run the HTTP server when MCP_TRANSPORT=http (gateway/container deployment),
# otherwise fall back to the stdio entrypoint (local/MCPB usage).
CMD ["sh", "-c", "if [ \"$MCP_TRANSPORT\" = \"http\" ]; then exec node dist/http.js; else exec node dist/index.js; fi"]

LABEL maintainer="engineering@wyre.ai"
LABEL version="${VERSION}"
LABEL description="Blumira MCP Server - Model Context Protocol server for Blumira SIEM"
LABEL org.opencontainers.image.title="blumira-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for Blumira SIEM integration"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/wyre-technology/blumira-mcp"
LABEL org.opencontainers.image.vendor="Wyre Technology"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL io.modelcontextprotocol.server.name="io.github.wyre-technology/blumira-mcp"
