FROM node:20-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app

COPY config /app/config
COPY services/workspace-service /app/services/workspace-service

CMD ["node", "/app/services/workspace-service/src/server.js"]
