# Networks that intercept TLS (corporate proxies, some antivirus suites) make npm
# fail with UNABLE_TO_VERIFY_LEAF_SIGNATURE. Default stays strict; build with
# --build-arg NPM_STRICT_SSL=false to opt out on such a network.
ARG NPM_STRICT_SSL=true

# Stage 1: build React dashboard
FROM node:22-alpine AS builder
ARG NPM_STRICT_SSL
WORKDIR /build
COPY dashboard/package*.json ./
RUN npm config set strict-ssl $NPM_STRICT_SSL && npm install
COPY dashboard/ ./
RUN npm run build

# Stage 2: proxy runtime + built dashboard
FROM node:22-alpine
ARG NPM_STRICT_SSL
WORKDIR /app
COPY proxy/package*.json ./
RUN npm config set strict-ssl $NPM_STRICT_SSL && npm install --omit=dev
COPY proxy/ ./
COPY --from=builder /build/dist ./public
EXPOSE 9999
CMD ["node", "index.js"]
