FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=Europe/Copenhagen \
    PORT=5000 \
    LUNCHLY_HOST=0.0.0.0 \
    LUNCHLY_DISABLE_HTTPS=1

WORKDIR /app
COPY --chown=node:node package.json server.js app.js index.html styles.css ./
RUN mkdir /app/data && chown node:node /app/data

USER node
EXPOSE 5000
CMD ["node", "server.js"]
