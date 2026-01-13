import { Hono } from "hono";
import adminRoutes from "./admin.ts";
import deviceRoutes from "./devices.ts";
import { Collections, getFirestore } from "../db/firestore.ts";

const api = new Hono();

// Device API routes (public for now - devices authenticate via device ID)
api.route("/devices", deviceRoutes);

// Admin routes (auth only required for Google Photos)
api.route("/admin", adminRoutes);

type ProcessingStartResponse = {
  attempt: number;
  devices: Array<{
    name: string;
    width: number;
    height: number;
    orientation: string;
  }>;
};

api.post("/processing/:imageId/start", async (c) => {
  const db = getFirestore();

  const devicesSnapshot = await db.collection(Collections.DEVICES).orderBy("created_at", "desc").get();

  const devices = devicesSnapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      name: data.name,
      width: data.width,
      height: data.height,
      orientation: data.orientation,
      created_at: data.created_at,
      last_seen: data.last_seen || null,
    };
  });

  return c.json({
    attempt: 1,
    devices,
  } as ProcessingStartResponse);
});

export default api;
