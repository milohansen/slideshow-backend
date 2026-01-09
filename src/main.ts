import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { initDatabase } from "./db/schema.ts";
import deviceRoutes from "./routes/devices.ts";
import adminRoutes from "./routes/admin.ts";
import uiRoutes from "./routes/ui.tsx";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", cors());

// Initialize database
await initDatabase();

// Routes
app.route("/ui", uiRoutes);
app.route("/api/devices", deviceRoutes);
app.route("/api/admin", adminRoutes);

// Redirect root to UI
app.get("/", (c) => {
  return c.redirect("/ui");
});

// Start server
const port = Number(Deno.env.get("PORT")) || 8000;

Deno.serve({ port, hostname: "0.0.0.0" }, app.fetch);

console.log(`🚀 Server running on http://localhost:${port}`);
