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
app.post("/api/ingest", (req, res) => {
  console.log("Received:", req.body);

  const payload = {
    ...req.body,
    received_at: new Date().toISOString()
  };

  // broadcast to WebSocket clients
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  });

  // send ONE response
  res.json({ success: true });
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
