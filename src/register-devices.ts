#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-ffi --allow-net
/**
 * Register devices from DEVICES.md file
 */

import { initFirestore } from "./db/firestore.ts";
import { upsertDevice, getAllDevices } from "./db/helpers-firestore.ts";

type Device = {
  id: string;
  name: string;
  area: string;
  width: number;
  height: number;
  type: string;
  orientation: "portrait" | "landscape";
}

const devices: Device[] = [
  {
    id: "kitchen-display",
    name: "Kitchen Display",
    area: "Kitchen",
    width: 1024,
    height: 600,
    type: "LCD",
    orientation: "landscape",
  },
  // {
  //   id: "bedroom-clock",
  //   name: "Clock",
  //   area: "Bedroom",
  //   width: 300,
  //   height: 400,
  //   type: "RLCD",
  //   orientation: "portrait",
  // },
  {
    id: "hallway-frame",
    name: "Frame",
    area: "Hallway",
    width: 800,
    height: 480,
    type: "E-Ink (Color)",
    orientation: "landscape",
  },
];

async function registerDevices() {
  await initFirestore();
  
  console.log(`Registering ${devices.length} devices...\n`);

  for (const device of devices) {
    console.log(`Registering ${device.name}...`);
    await upsertDevice({
      id: device.id,
      name: device.name,
      width: device.width,
      height: device.height,
      orientation: device.orientation,
      gap: 0,
      created_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
    });
    console.log(`  ✓ ${device.name} (${device.width}x${device.height} ${device.orientation})`);
  }

  console.log("\n✅ All devices registered");
  console.log("\nCurrent devices:");
  const allDevices = await getAllDevices();
  allDevices.forEach(d => console.log(`  - ${d.id}: ${d.name} (${d.width}x${d.height} ${d.orientation})`));
}

// if (import.meta.url === `file://${process.argv[1]}`) {
//   await registerDevices();
// }
