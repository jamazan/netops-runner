FROM node:20-alpine
RUN apk add --no-cache openssh-client
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.js .
EXPOSE 3001
CMD ["node", "server.js"]
