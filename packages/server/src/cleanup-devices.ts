#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-ffi --allow-net
/**
 * Clean up placeholder/test devices from database
 */

import { initFirestore } from "./db/firestore.ts";
import { getAllDevices, deleteDevice } from "./db/helpers-firestore.ts";

const VALID_DEVICE_IDS = [
  "kitchen-display",
  "bedroom-clock",
  "hallway-frame",
];

async function cleanupDevices() {
  await initFirestore();

  console.log("Current devices in database:");
  const allDevices = await getAllDevices();
  allDevices.forEach(d => console.log(`  - ${d.id}: ${d.name}`));

  const toDelete = allDevices.filter(d => !VALID_DEVICE_IDS.includes(d.id));
  
  if (toDelete.length === 0) {
    console.log("\n✅ No placeholder devices to clean up");
    return;
  }

  console.log("\nRemoving placeholder devices:");
  toDelete.forEach(d => console.log(`  - ${d.id}: ${d.name}`));

  for (const device of toDelete) {
    await deleteDevice(device.id);
  }

  console.log("\n✅ Cleanup complete");
  console.log("\nRemaining devices:");
  const remaining = await getAllDevices();
  remaining.forEach(d => console.log(`  - ${d.id}: ${d.name}`));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await cleanupDevices();
}
