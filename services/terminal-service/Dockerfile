FROM node:20-alpine

WORKDIR /app/services/terminal-service

COPY services/terminal-service/package.json ./
RUN npm install --omit=dev

COPY services/terminal-service/src ./src

CMD ["node", "/app/services/terminal-service/src/server.js"]
