# Single image: the Node server serves the built PWA and the WebSocket on one port.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm --filter @pulse/protocol build && pnpm --filter @pulse/server build && pnpm --filter @pulse/web build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/app/data WEB_DIST=/app/apps/web/dist
# Same layout as the workspace so pnpm's symlinked node_modules resolve.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "apps/server/dist/index.js"]
