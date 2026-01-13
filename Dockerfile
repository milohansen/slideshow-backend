# Multi-stage build for efficient caching
FROM node:24-slim AS deps

WORKDIR /app

# Install Yarn using the official distribution repository
RUN curl -sS https://dl.yarnpkg.com/debian/pubkey.gpg | apt-key add - \
    && echo "deb https://dl.yarnpkg.com/debian/ stable main" | tee /etc/apt/sources.list.d/yarn.list \
    && apt-get update && apt-get install -y yarn

# Copy dependency files
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install --frozen-lockfile

# Final stage
FROM node:24-slim

WORKDIR /app

# Install Yarn using the official distribution repository
RUN curl -sS https://dl.yarnpkg.com/debian/pubkey.gpg | apt-key add - \
    && echo "deb https://dl.yarnpkg.com/debian/ stable main" | tee /etc/apt/sources.list.d/yarn.list \
    && apt-get update && apt-get install -y yarn

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
