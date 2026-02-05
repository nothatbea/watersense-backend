const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Health check
app.get("/", (req, res) => {
  res.send("Node backend is running");
});

// Test API (ESP32 will hit this later)
app.post("/api/ingest", (req, res) => {
  console.log("Received:", req.body);

  // broadcast to WebSocket clients
  const payload = {
    ...req.body,
    received_at: new Date().toISOString()
  };

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  });

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
