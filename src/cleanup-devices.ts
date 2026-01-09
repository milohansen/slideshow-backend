#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-ffi
/**
 * Clean up placeholder/test devices from database
 */

import { initDatabase, getDb } from "./db/schema.ts";

const VALID_DEVICE_IDS = [
  "kitchen-display",
  "bedroom-clock",
  "hallway-frame",
];

async function cleanupDevices() {
  await initDatabase();
  const db = getDb();

  console.log("Current devices in database:");
  const allDevices = db.prepare("SELECT id, name FROM devices").all() as Array<{ id: string; name: string }>;
  allDevices.forEach(d => console.log(`  - ${d.id}: ${d.name}`));

  const toDelete = allDevices.filter(d => !VALID_DEVICE_IDS.includes(d.id));
  
  if (toDelete.length === 0) {
    console.log("\n✅ No placeholder devices to clean up");
    return;
  }

  console.log("\nRemoving placeholder devices:");
  toDelete.forEach(d => console.log(`  - ${d.id}: ${d.name}`));

  db.prepare(`DELETE FROM devices WHERE id NOT IN (${VALID_DEVICE_IDS.map(() => '?').join(', ')})`).run(...VALID_DEVICE_IDS);

  console.log("\n✅ Cleanup complete");
  console.log("\nRemaining devices:");
  const remaining = db.prepare("SELECT id, name FROM devices").all() as Array<{ id: string; name: string }>;
  remaining.forEach(d => console.log(`  - ${d.id}: ${d.name}`));
}

if (import.meta.main) {
  await cleanupDevices();
}
