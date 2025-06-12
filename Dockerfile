FROM ghcr.io/cloud-cli/node:latest
USER root
COPY . /home/app
ENV NODE_ENV=production
RUN cd /home/app && npm i && npm run build && rm -r src/
