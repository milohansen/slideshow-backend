FROM denoland/deno:2.1.4

WORKDIR /app

# Copy dependency files
COPY deno.json .

# Cache dependencies
RUN deno cache --reload src/main.ts || true

# Copy source code
COPY . .

# Cache the main entry point
RUN deno cache src/main.ts

# Expose port
EXPOSE 8000

# Run the application
CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-ffi", "--allow-run", "src/main.ts"]
