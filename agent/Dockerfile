FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV PORT=9101

EXPOSE 9101

CMD ["npm", "start"]
