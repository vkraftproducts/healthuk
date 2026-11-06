# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/api/Dockerfile -t hub-api .
FROM node:22.23-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@hub/api...
RUN pnpm deploy --legacy --filter=@hub/api --prod /out

FROM node:22.23-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out .
# Evidence store mount point, owned by node so a fresh volume is writable.
RUN mkdir -p /data/evidence && chown node:node /data/evidence
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
