import { Hono } from "hono";
import adminRoutes from "./admin.ts";
import deviceRoutes from "./devices.ts";
import processingRoutes from "./processing.ts";
import { Collections, getFirestore } from "../db/firestore.ts";

const api = new Hono();

// Device API routes (public for now - devices authenticate via device ID)
api.route("/devices", deviceRoutes);

// Admin routes
api.route("/admin", adminRoutes);

api.route("/processing", processingRoutes);

export default api;
