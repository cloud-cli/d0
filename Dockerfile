FROM ghcr.io/cloud-cli/node:latest
COPY . /home/app
RUN cd /home/app && npm i && npm run build && rm -r src/
ENV NODE_ENV=production
