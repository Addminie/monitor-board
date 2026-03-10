FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public
COPY config ./config

ENV PORT=9200

EXPOSE 9200

CMD ["npm", "start"]
