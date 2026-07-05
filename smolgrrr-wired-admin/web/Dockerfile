FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache font-dejavu

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json tsconfig.admin-client.json ./
COPY server.ts ./server.ts
COPY src ./src
COPY public ./public

RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
