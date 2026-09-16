# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build the UI
FROM node:24-slim AS build
WORKDIR /src
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm install --no-audit --no-fund
COPY web ./web
# scripts/ carries check-css.mjs, which fails the build if the image CSS contract is
# broken (see web/src/styles.css). The guard runs here, not just on a laptop.
COPY scripts ./scripts
RUN npm run build   # emits server/public, then runs check-css

# ------------------------------------------------- runtime dependencies (sharp)
FROM node:24-slim AS deps
WORKDIR /app
COPY server/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# --------------------------------------------------------------------- runtime
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    NETCLIP_DATA_DIR=/data \
    PORT=3210
WORKDIR /app

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=deps  /app/package.json ./package.json
COPY --from=build /src/server/public ./public
COPY server/src ./src

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3210

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3210)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/index.js"]
