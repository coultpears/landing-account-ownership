# ---- Build stage ----
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# ---- Runtime stage ----
FROM node:20-alpine

WORKDIR /app

# Run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src/         ./src/
COPY data/        ./data/
COPY server.js    ./

# data/ directory needs write access for cache.json and log.json
RUN chown -R appuser:appgroup /app
USER appuser

# Cloud Run injects PORT at runtime; default to 3000 for local docker run
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
