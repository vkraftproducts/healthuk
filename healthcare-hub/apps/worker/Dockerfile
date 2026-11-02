# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/worker/Dockerfile -t hub-worker .
FROM node:22.23-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@hub/worker...
RUN pnpm deploy --legacy --filter=@hub/worker --prod /out

FROM node:22.23-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out .
USER node

CMD ["node", "dist/main.js"]
