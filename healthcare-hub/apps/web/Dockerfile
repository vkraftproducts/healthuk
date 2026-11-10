# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/web/Dockerfile -t hub-web .
FROM node:22.23-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
# Baked into the bundle at build time: dev | local | entra (match the API's AUTH_MODE).
ARG VITE_AUTH_MODE=local
ENV VITE_AUTH_MODE=$VITE_AUTH_MODE
RUN pnpm turbo run build --filter=@hub/web...

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
