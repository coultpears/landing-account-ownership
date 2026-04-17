# ---- Build stage ----
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# ---- Runtime stage ----
FROM node:20-alpine

WORKDIR /app

# Python + pdfplumber for CoStar PDF parser (scripts/parse-costar-pdf.py)
# Alpine uses apk; pdfplumber needs build deps for the cffi/pycryptodome stack.
RUN apk add --no-cache python3 py3-pip py3-setuptools \
 && pip3 install --break-system-packages --no-cache-dir pdfplumber \
 && ln -sf /usr/bin/python3 /usr/local/bin/python

# Run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src/         ./src/
COPY data/        ./data/
COPY scripts/     ./scripts/
COPY server.js    ./

# data/ directory needs write access for cache.json and log.json
RUN chown -R appuser:appgroup /app
USER appuser

# Cloud Run injects PORT at runtime; default to 3000 for local docker run
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
