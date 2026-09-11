FROM ghcr.io/cloud-cli/image-node:latest AS builder
COPY . .
USER 0
RUN pnpm i && pnpm build && rm -rf src/ && pnpm clean
ENV NODE_ENV=production
RUN pnpm i --prod --frozen-lockfile && pnpm rebuild better-sqlite3
ENV DATA_PATH=/home/app/data
RUN mkdir -p /home/app/data && chown node:node /home/app/data
USER 1000
VOLUME ["/home/app/data"]
