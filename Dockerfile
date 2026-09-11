FROM ghcr.io/cloud-cli/image-node:latest AS builder

USER root
WORKDIR /home/app
COPY . /home/app
ENV CI=true
RUN npm install --global pnpm@12.3.4
RUN pnpm i && pnpm build && rm -rf node_modules/ src/

FROM ghcr.io/cloud-cli/image-node:latest

USER root
ENV NODE_ENV=production
ENV DATA_PATH=/home/app/data
WORKDIR /home/app
COPY --from=builder --chown=node:node /home/app/ ./
RUN npm install --global pnpm@12.3.4
RUN pnpm install --prod --frozen-lockfile && pnpm rebuild better-sqlite3
RUN mkdir -p /home/app/data && chown node:node /home/app/data
VOLUME ["/home/app/data"]
USER node
