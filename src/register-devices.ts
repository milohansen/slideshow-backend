#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-ffi
/**
 * Register devices from DEVICES.md file
 */

import { initDatabase } from "./db/schema.ts";

interface Device {
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
  await initDatabase();
  
  const { getDb } = await import("./db/schema.ts");
  const db = getDb();

  console.log("Registering devices from DEVICES.md...\n");

  for (const device of devices) {
    db.prepare(`
      INSERT INTO devices (id, name, width, height, orientation, last_seen)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        width = excluded.width,
        height = excluded.height,
        orientation = excluded.orientation,
        last_seen = CURRENT_TIMESTAMP
    `).run(device.id, device.name, device.width, device.height, device.orientation);

    console.log(`✓ Registered: ${device.name} (${device.area}) - ${device.width}x${device.height} ${device.orientation} ${device.type}`);
  }

  console.log(`\n✅ Successfully registered ${devices.length} devices`);
}

if (import.meta.main) {
  await registerDevices();
}
