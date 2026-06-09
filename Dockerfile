# Stage 1: build React dashboard
FROM node:22-alpine AS builder
WORKDIR /build
COPY dashboard/package*.json ./
RUN npm install
COPY dashboard/ ./
RUN npm run build

# Stage 2: proxy runtime + built dashboard
FROM node:22-alpine
WORKDIR /app
COPY proxy/package*.json ./
RUN npm install --omit=dev
COPY proxy/ ./
COPY --from=builder /build/dist ./public
EXPOSE 9999
CMD ["node", "index.js"]
