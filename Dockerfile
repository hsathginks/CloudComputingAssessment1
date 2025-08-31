# syntax=docker/dockerfile:1

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
CMD ["node", "server.js"]
EXPOSE 3000
