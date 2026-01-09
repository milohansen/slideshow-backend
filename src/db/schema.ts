import { Database } from "sqlite";

let db: Database;

export function getDb(): Database {
  if (!db) {
    throw new Error("Database not initialized");
  }
  return db;
}

// deno-lint-ignore require-await
export async function initDatabase() {
  db = new Database("slideshow.db");

  // Enable WAL mode for better concurrency and crash recovery
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA wal_autocheckpoint=1000");
  db.exec("PRAGMA busy_timeout=5000");

  // Images table - stores original image metadata
  db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL UNIQUE,
      file_hash TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      orientation TEXT NOT NULL CHECK(orientation IN ('portrait', 'landscape', 'square')),
      thumbnail_path TEXT,
      ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_modified DATETIME NOT NULL
    )
  `);

  // Processed images table - stores resized variants with color data
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_images (
      id TEXT PRIMARY KEY,
      image_id TEXT NOT NULL,
      device_size TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      color_primary TEXT NOT NULL,
      color_secondary TEXT NOT NULL,
      color_tertiary TEXT NOT NULL,
      color_palette TEXT NOT NULL,
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
      UNIQUE(image_id, device_size)
    )
  `);

  // Devices table - stores device configurations
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      orientation TEXT NOT NULL CHECK(orientation IN ('portrait', 'landscape')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME
    )
  `);

  // Device queue state table - persists slideshow queue per device
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_queue_state (
      device_id TEXT PRIMARY KEY,
      queue_data TEXT NOT NULL,
      current_index INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    )
  `);

  // Create indices for better query performance
  db.exec(`CREATE INDEX IF NOT EXISTS idx_images_orientation ON images(orientation)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_processed_images_image_id ON processed_images(image_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_processed_images_device_size ON processed_images(device_size)`);

  // Initialize with default devices if table is empty
  initializeDefaultDevices(db);

  console.log("✅ Database initialized");
}

/**
 * Initialize default devices if devices table is empty
 */
function initializeDefaultDevices(db: Database): void {
  const count = db.prepare("SELECT COUNT(*) as count FROM devices").get() as { count: number };
  
  if (count.count === 0) {
    console.log("📱 Initializing default devices...");
    
    const defaultDevices = [
      {
        id: "kitchen-display",
        name: "Kitchen Display",
        width: 1024,
        height: 600,
        orientation: "landscape",
      },
      {
        id: "bedroom-clock",
        name: "Bedroom Clock",
        width: 300,
        height: 400,
        orientation: "portrait",
      },
    ];
    
    const stmt = db.prepare(`
      INSERT INTO devices (id, name, width, height, orientation, last_seen)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    
    for (const device of defaultDevices) {
      stmt.run(device.id, device.name, device.width, device.height, device.orientation);
      console.log(`  ✓ ${device.name} (${device.width}x${device.height} ${device.orientation})`);
    }
    
    console.log(`✅ Initialized ${defaultDevices.length} default devices`);
  }
}

export function closeDatabase() {
  if (db) {
    db.close();
  }
}
