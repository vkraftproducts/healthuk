# syntax=docker/dockerfile:1
# One-shot database setup for the Coolify demo stack: roles, migrations and the synthetic seed.
# Every step is idempotent, so it runs on each deploy. Build from the repository root.
FROM node:22.23-bookworm-slim
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@hub/db...
CMD ["sh", "-c", "pnpm db:bootstrap && pnpm db:migrate && pnpm db:seed && pnpm db:seed:sectors"]
