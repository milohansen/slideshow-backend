import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { randomUUID } from "crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { initFirestore } from "./db/firestore.ts";
import { optionalAuth } from "./middleware/auth.ts";
import apiRoutes from "./routes/api.ts";
import authRoutes from "./routes/auth.ts";
import uiRoutes from "./routes/ui.tsx";
import { initStorage } from "./services/storage.ts";
import { runPendingJobs } from "./services/jobs.ts";
import { analyzeAllUnanalyzedImages } from "./services/ai.ts";
import { cleanDuplicateDeviceVariants } from "./db/helpers-firestore.ts";

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
  runPendingJobs();
} catch (error) {
  console.error("🔥 Failed to initialize Firestore:", error);
  console.error("💡 Make sure:");
  console.error("   1. GCP_PROJECT environment variable is set");
  console.error("   2. Service account credentials are properly configured");
  console.error("   3. Network connectivity to Firestore is available");
  process.exit(1);
}

analyzeAllUnanalyzedImages().catch((error) => {
  console.error("🔥 Failed to analyze unanalyzed images on startup:", error);
});

// Health check endpoint for Cloud Run
app.get("/_health", (c) => {
  return c.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

// Routes
app.route("/auth", authRoutes);

app.route("/api", apiRoutes);

// Public UI routes (with optional auth for better UX)
// app.use("/ui/*", optionalAuth);
// app.route("/ui", uiRoutes);

// Serve static assets
app.use("/assets/*", serveStatic({ root: "./" }));

// Redirect root to UI
app.use("*", optionalAuth);
app.route("/", uiRoutes);

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
