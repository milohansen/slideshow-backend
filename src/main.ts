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

// Health check endpoint for Cloud Run
app.get("/_health", (c) => {
  return c.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Routes
app.route("/ui", uiRoutes);
app.route("/api/devices", deviceRoutes);
app.route("/api/admin", adminRoutes);

// Redirect root to UI
app.get("/", (c) => {
  return c.redirect("/ui");
});

// Cloud Run sets PORT environment variable (default to 8080 for local dev)
const port = Number(Deno.env.get("PORT")) || 8080;

const server = Deno.serve({ 
  port, 
  hostname: "0.0.0.0",
  onListen: ({ hostname, port }) => {
    console.log(`🚀 Server running on http://${hostname}:${port}`);
  }
}, app.fetch);

// Graceful shutdown handling for Cloud Run
const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, starting graceful shutdown...`);
  
  try {
    await server.shutdown();
    console.log("Server closed successfully");
    Deno.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    Deno.exit(1);
  }
};

// Handle termination signals (Cloud Run sends SIGTERM)
Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
