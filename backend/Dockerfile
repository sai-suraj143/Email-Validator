# Backend Dockerfile for the Email Validator API
FROM node:22-alpine

WORKDIR /app

# Install production dependencies only.
COPY package.json package-lock.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy application source.
COPY . .

# Runtime configuration (can be overridden at runtime).
ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

CMD ["node", "server.js"]
