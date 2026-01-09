import { Hono } from "hono";
import { ingestImagesFromDirectory, getImageStats } from "../services/image-ingestion.ts";
import { processAllImages, loadConfig } from "../services/image-processing.ts";

const admin = new Hono();

// Get image statistics
admin.get("/stats", (c) => {
  const stats = getImageStats();
  return c.json(stats);
});

// Trigger image ingestion
admin.post("/ingest", async (c) => {
  const body = await c.req.json();
  const { directory, recursive = true } = body;

  if (!directory) {
    return c.json({ error: "Directory path required" }, 400);
  }

  try {
    await Deno.stat(directory);
  } catch {
    return c.json({ error: `Directory not found: ${directory}` }, 404);
  }

  // Run ingestion asynchronously
  const result = await ingestImagesFromDirectory(directory, {
    recursive,
    verbose: false,
  });

  return c.json({
    success: true,
    result,
  });
});

// Trigger image processing
admin.post("/process", async (c) => {
  const config = await loadConfig();
  const outputDir = config.processedImageDirectory || "data/processed";

  const result = await processAllImages(outputDir, {
    verbose: false,
  });

  return c.json({
    success: true,
    result,
  });
});

export default admin;
