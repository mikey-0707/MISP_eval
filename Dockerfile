FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV HOST=0.0.0.0
ENV PORT=3000
ENV APP_DATA_DIR=/data

VOLUME ["/data"]

EXPOSE 3000

CMD ["npm", "start"]
