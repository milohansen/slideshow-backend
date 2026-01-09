import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { initDatabase } from "./db/schema.ts";
import deviceRoutes from "./routes/devices.ts";
import adminRoutes from "./routes/admin.ts";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", cors());

// Initialize database
await initDatabase();

// Routes
app.get("/", (c) => {
  return c.json({
    name: "ESPHome Photo Slideshow Backend",
    version: "1.0.0",
    status: "running",
  });
});

app.route("/api/devices", deviceRoutes);
app.route("/api/admin", adminRoutes);

// Start server
const port = Number(Deno.env.get("PORT")) || 8000;

Deno.serve({ port, hostname: "0.0.0.0" }, app.fetch);

console.log(`🚀 Server running on http://localhost:${port}`);
