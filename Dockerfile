FROM ghcr.io/cloud-cli/node:latest
COPY --chown=node:node . /home/app
ENV NODE_ENV=production
RUN cd /home/app && npm i && npx tsc && rm -r src/
