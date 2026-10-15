# TLG — The LAN Game (Kerker). Ein Image: Node-Server liefert API, Sockets und den gebauten Client.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY packages/shared packages/shared
COPY server server
COPY --from=build /app/client/dist client/dist
ARG COMMIT_SHA=dev
RUN echo "$COMMIT_SHA" > server/src/VERSION
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
USER node
CMD ["node", "server/src/index.js"]
