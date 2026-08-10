FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY LICENSE README.md ./
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="One Status"
LABEL org.opencontainers.image.description="Cross-device AI tool, encrypted credential, memory, and work state control center"
LABEL org.opencontainers.image.licenses="Apache-2.0"

COPY --from=build /app/dist/one-status.js /usr/local/bin/one-status
COPY --from=build /app/LICENSE /usr/share/doc/one-status/LICENSE
COPY --from=build /app/dist/THIRD_PARTY_NOTICES.txt /usr/share/doc/one-status/THIRD_PARTY_NOTICES.txt
RUN chmod 0755 /usr/local/bin/one-status && mkdir -p /data && chown node:node /data

ENV NODE_ENV=production
ENV ONE_STATUS_HOME=/data/client
ENV ONE_STATUS_MCP_HOST=0.0.0.0
ENV ONE_STATUS_MCP_PORT=3000

EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=15s --start-period=10s --retries=3 \
  CMD node -e "const fs=require('node:fs');const t=process.env.ONE_STATUS_MCP_BEARER_TOKEN||(process.env.ONE_STATUS_MCP_BEARER_TOKEN_FILE?fs.readFileSync(process.env.ONE_STATUS_MCP_BEARER_TOKEN_FILE,'utf8').trim():'');fetch('http://127.0.0.1:'+(process.env.ONE_STATUS_MCP_PORT||3000)+'/ready',{headers:t?{authorization:'Bearer '+t}:{}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["one-status"]
CMD ["mcp", "--transport", "http"]
