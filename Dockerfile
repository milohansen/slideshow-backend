# Use official Deno image
FROM denoland/deno:2.6.4

# Set working directory
WORKDIR /app

# Copy dependency files first for better caching
COPY deno.json deno.lock ./

# Cache dependencies
RUN deno install --entrypoint src/main.ts || true

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
CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-ffi", "--allow-run", "src/main.ts"]
