FROM ghcr.io/cloud-cli/node:latest AS builder

USER root
WORKDIR /home/app
COPY . /home/app
ENV CI=true
RUN pnpm i && pnpm build && rm -rf node_modules/ src/ && pnpm store prune

FROM ghcr.io/cloud-cli/node:latest

ENV NODE_ENV=production
WORKDIR /home/app
COPY --from=builder /home/app/ ./
RUN pnpm install --prod
