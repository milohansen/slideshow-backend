import { crypto } from "@std/crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/deno";
import { logger } from "hono/logger";
import { initFirestore } from "./db/firestore.ts";
import { optionalAuth } from "./middleware/auth.ts";
import adminRoutes from "./routes/admin.ts";
import authRoutes from "./routes/auth.ts";
import deviceRoutes from "./routes/devices.ts";
import uiRoutes from "./routes/ui.tsx";
import { initJobQueue, shutdownJobQueue } from "./services/job-queue.ts";
import { initStorage } from "./services/storage.ts";

const app = new Hono();

// Generate unique app instance ID
export const APP_INSTANCE_ID = crypto.randomUUID();
console.log(`🆔 App instance ID: ${APP_INSTANCE_ID}`);

// Middleware
app.use("*", logger());
app.use("*", cors());

// Initialize storage first
initStorage();

// Initialize Firestore
await initFirestore();

// Initialize job queue service
initJobQueue();

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

// Device API routes (public for now - devices authenticate via device ID)
app.route("/api/devices", deviceRoutes);

// Admin routes (auth only required for Google Photos)
app.route("/api/admin", adminRoutes);

// Redirect root to UI
app.get("/", (c) => {
  return c.redirect("/ui");
});

// Cloud Run sets PORT environment variable (default to 8080 for local dev)
const port = Number(Deno.env.get("PORT")) || 8080;

const server = Deno.serve(
  {
    port,
    hostname: "0.0.0.0",
    onListen: ({ hostname, port }) => {
      console.log(`🚀 Server running on http://${hostname}:${port}`);
    },
  },
  app.fetch
);

// Graceful shutdown handling for Cloud Run
const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, starting graceful shutdown...`);

  try {
    // Flush pending job queue
    await shutdownJobQueue();

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
