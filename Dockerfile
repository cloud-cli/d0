FROM ghcr.io/cloud-cli/image-node:latest AS builder
COPY . .
ENV CI=true
RUN pnpm i && pnpm build && rm -rf node_modules/ src/
ENV NODE_ENV=production
RUN pnpm i --prod --frozen-lockfile && pnpm rebuild better-sqlite3
ENV DATA_PATH=/home/app/data
RUN mkdir -p /home/app/data && chown node:node /home/app/data
VOLUME ["/home/app/data"]
