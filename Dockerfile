FROM ghcr.io/cloud-cli/node:latest

USER root
WORKDIR /home/app
COPY . /home/app
RUN npm i && npm run build && rm -r src/ node_modules/ && npm cache clean --force
ENV NODE_ENV=production
RUN npm install --omit=dev && npm cache clean --force
