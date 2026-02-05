const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
app.get("/api/init-db", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS readings (
        id SERIAL PRIMARY KEY,
        device_id TEXT NOT NULL,
        water_level_cm INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
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
