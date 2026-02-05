const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const { InfluxDB, Point } = require("@influxdata/influxdb-client");

const influx = new InfluxDB({
  url: process.env.INFLUX_URL,
  token: process.env.INFLUX_TOKEN
});

const writeApi = influx.getWriteApi(
  process.env.INFLUX_ORG,
  process.env.INFLUX_BUCKET,
  "ms"
);

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
app.get("/api/init-db", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        role TEXT NOT NULL DEFAULT 'staff'
          CHECK (role IN ('admin', 'staff')),
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'inactive')),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sms_subscribers (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(20) NOT NULL UNIQUE,
        location VARCHAR(100) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sensorsetting (
        id SERIAL PRIMARY KEY,
        sensorid INTEGER NOT NULL UNIQUE,
        calib_offset REAL DEFAULT 0,
        calib_scale REAL DEFAULT 1,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS alert_notifications (
        id SERIAL PRIMARY KEY,
        subscriber_id INTEGER NOT NULL,
        alert_type VARCHAR(50) DEFAULT 'WATER_LEVEL',
        water_level_cm INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('SAFE','ALERT','CAUTION','WARNING','DANGER','EMERGENCY')
        ),
        channel TEXT DEFAULT 'SMS' CHECK (channel IN ('SMS')),
        message TEXT NOT NULL,
        sent_at TIMESTAMP DEFAULT NULL,
        delivery_status SMALLINT NOT NULL DEFAULT 0,
        attempt_count INTEGER DEFAULT 0,
        error_message VARCHAR(255),
        CONSTRAINT fk_alert_subscriber
          FOREIGN KEY (subscriber_id)
          REFERENCES sms_subscribers(id)
          ON DELETE CASCADE
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_subscriber_id
      ON alert_notifications(subscriber_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_delivery_status
      ON alert_notifications(delivery_status);
    `);

    res.send("Database initialized");
  } catch (err) {
    console.error(err);
    res.status(500).send("DB init failed");
  }
});


// Health check
app.get("/", (req, res) => {
  res.send("Node backend is running");
});

// Test API (ESP32 will hit this later)
app.post("/api/ingest", async (req, res) => {
  const { device_id, water_level_cm } = req.body;

  if (!device_id || water_level_cm === undefined) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  try {
    // save to PostgreSQL
    await pool.query(
      "INSERT INTO readings (device_id, water_level_cm) VALUES ($1, $2)",
      [device_id, water_level_cm]
    );

    const payload = {
      device_id,
      water_level_cm,
      received_at: new Date().toISOString()
    };

    const point = new Point("water_level")
  .tag("device_id", device_id)
  .floatField("value", water_level_cm)
  .timestamp(new Date());

writeApi.writePoint(point);
await writeApi.flush();


    // broadcast via WebSocket
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(payload));
      }
    });

    res.json({ success: true });
  } catch (err) {
    console.error("INGEST ERROR:", err);
    res.status(500).json({ success: false });
  }
});


// WebSocket connections
wss.on("connection", ws => {
  console.log("WebSocket client connected");
  ws.send(JSON.stringify({ message: "Connected to WebSocket" }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
