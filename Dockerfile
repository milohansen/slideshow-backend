FROM node:24-slim

WORKDIR /app

# Install Yarn using the official distribution repository
RUN corepack enable \
    && yarn set version berry \
    && yarn -v

# Copy package files
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install --immutable

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
CMD ["yarn", "tsx", "packages/server/src/main.ts"]
