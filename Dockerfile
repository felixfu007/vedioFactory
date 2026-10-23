FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node server.js index.html ./
COPY --chown=node:node assets ./assets
COPY --chown=node:node modules ./modules
RUN mkdir -p /data/output /data/models /data/app /workflows \
  && chown -R node:node /data

ENV HOST=0.0.0.0 \
    PORT=8000 \
    VEDIO_FACTORY_OUTPUT_DIR=/data/output \
    VEDIO_FACTORY_MODEL_DIR=/data/models \
    VEDIO_FACTORY_DATA_DIR=/data/app \
    VEDIO_FACTORY_WORKFLOWS_DIR=/workflows

USER node
EXPOSE 8000

CMD ["node", "server.js"]
