# Multi-stage build for efficient caching
FROM node:24-slim AS deps

WORKDIR /app

# Install Yarn using the official distribution repository
RUN corepack enable \
    && yarn set version berry

# Copy dependency files
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install --frozen-lockfile

# Final stage
FROM node:24-slim

WORKDIR /app

# Install Yarn using the official distribution repository
RUN corepack enable \
    && yarn set version berry


# Copy package files
COPY package.json yarn.lock ./

# Copy cached dependencies from previous stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/.yarn ./.yarn

# Copy source code
COPY . .

# Create data directories with proper permissions
RUN mkdir -p /app/data /app/data/processed && \
    chmod -R 755 /app/data

# Set production environment
ENV NODE_ENV=production

# Cloud Run sets PORT environment variable (default to 8080)
EXPOSE 8080

# Run the application
CMD ["yarn", "start"]
