#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-ffi
/**
 * Clean up all images and processed images from database
 */

import { initDatabase, getDb } from "./db/schema.ts";

async function cleanupImages() {
  await initDatabase();
  const db = getDb();

  console.log("Current state:");
  const imageCount = db.prepare("SELECT COUNT(*) as count FROM images").get() as { count: number };
  const processedCount = db.prepare("SELECT COUNT(*) as count FROM processed_images").get() as { count: number };
  console.log(`  - Images: ${imageCount.count}`);
  console.log(`  - Processed variants: ${processedCount.count}`);

  if (imageCount.count === 0 && processedCount.count === 0) {
    console.log("\n✅ Database is already clean");
    return;
  }

  console.log("\nCleaning up...");
  db.prepare("DELETE FROM processed_images").run();
  db.prepare("DELETE FROM images").run();
  db.prepare("DELETE FROM device_queue_state").run();

  console.log("\n✅ Cleanup complete");
  console.log("  - All images removed");
  console.log("  - All processed variants removed");
  console.log("  - All queue states cleared");
}

if (import.meta.main) {
  await cleanupImages();
}
