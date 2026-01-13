# Multi-stage build for efficient caching
FROM denoland/deno:2.6.4 AS deps

WORKDIR /app

# Copy dependency files
COPY deno.json deno.lock ./

# Enable node_modules directory for npm packages (sharp needs native bindings)
ENV DENO_NODE_MODULES_DIR=auto

# Copy source files for dependency resolution
COPY src/main.ts ./

# Pre-cache dependencies with lock file
RUN deno cache --frozen main.ts

# Final stage
FROM denoland/deno:2.6.4

WORKDIR /app

# Copy cached dependencies from previous stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /deno-dir /deno-dir

# Enable node_modules directory
ENV DENO_NODE_MODULES_DIR=auto
ENV DENO_DIR=/deno-dir

# Copy dependency files
COPY deno.json deno.lock ./

# Copy source code
COPY . .

# Create data directories with proper permissions
RUN mkdir -p /app/data /app/data/processed && \
    chmod -R 755 /app/data

# Set production environment
ENV DENO_ENV=production

# Cloud Run sets PORT environment variable (default to 8080)
EXPOSE 8080

# Run the application
CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-ffi", "--allow-run", "main.ts"]
