FROM node:20-alpine

WORKDIR /app

COPY web/client /app/web/client
COPY services/api-gateway /app/services/api-gateway

CMD ["node", "/app/services/api-gateway/src/server.js"]

