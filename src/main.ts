import { serve } from "@hono/node-server";
import { serveStatic } from '@hono/node-server/serve-static'
import { randomUUID } from "crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { initFirestore } from "./db/firestore.ts";
import { optionalAuth } from "./middleware/auth.ts";
import adminRoutes from "./routes/admin.ts";
import authRoutes from "./routes/auth.ts";
import deviceRoutes from "./routes/devices.ts";
import uiRoutes from "./routes/ui.tsx";
import { initStorage } from "./services/storage.ts";

const app = new Hono();

// Generate unique app instance ID
export const APP_INSTANCE_ID = randomUUID();
console.log(`🆔 App instance ID: ${APP_INSTANCE_ID}`);

// Middleware
app.use("*", logger());
app.use("*", cors());

// Initialize storage first
initStorage();

// Initialize Firestore with error handling
try {
  await initFirestore();
} catch (error) {
  console.error("🔥 Failed to initialize Firestore:", error);
  console.error("💡 Make sure:");
  console.error("   1. GCP_PROJECT environment variable is set");
  console.error("   2. Service account credentials are properly configured");
  console.error("   3. Network connectivity to Firestore is available");
  process.exit(1);
}

// Health check endpoint for Cloud Run
app.get("/_health", (c) => {
  return c.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

// Routes
app.route("/auth", authRoutes);

// Serve static assets
app.use("/assets/*", serveStatic({ root: "./" }));

// Public UI routes (with optional auth for better UX)
app.use("/ui/*", optionalAuth);
app.route("/ui", uiRoutes);
app.get("/home", (c) => {
  return c.text("Home sweet home!");
});

// Device API routes (public for now - devices authenticate via device ID)
app.route("/api/devices", deviceRoutes);

// Admin routes (auth only required for Google Photos)
app.route("/api/admin", adminRoutes);

// Redirect root to UI
app.get("/", (c) => {
  return c.redirect("/ui");
});

// Cloud Run sets PORT environment variable (default to 8080 for local dev)
const port = Number(process.env.PORT) || 8080;

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`🚀 Server running on http://0.0.0.0:${info.port}`);
});

// Graceful shutdown handling for Cloud Run
const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, starting graceful shutdown...`);

  try {
    server.close(() => {
      console.log("Server closed successfully");
      process.exit(0);
    });
  } catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
};

// Handle termination signals (Cloud Run sends SIGTERM)
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
