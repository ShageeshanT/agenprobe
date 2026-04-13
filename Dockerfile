FROM node:22-slim

# Railway CLI for SSH-based checks
RUN npm install -g @railway/cli

WORKDIR /app

# Install deps first (cache layer)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Build TypeScript (if we ever add a build step; tsx handles it at runtime for now)
# RUN npm run build

# Default port
ENV PORT=4000

EXPOSE 4000

# Start the web dashboard
CMD ["npx", "tsx", "scripts/run-web.ts"]
