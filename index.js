const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const { InfluxDB, Point } = require("@influxdata/influxdb-client");
const { Pool } = require("pg");

// 2️⃣ App + middleware
const app = express();
app.use(cors());
app.use(express.json());

// 3️⃣ Server + WebSocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 4️⃣ PostgreSQL (BEFORE checkAlerts)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 5️⃣ InfluxDB
const influx = new InfluxDB({
  url: process.env.INFLUX_URL,
  token: process.env.INFLUX_TOKEN
});

const writeApi = influx.getWriteApi(
  process.env.INFLUX_ORG,
  process.env.INFLUX_BUCKET,
  "ms"
);
async function checkAlerts({
  waterLevel,
  location_id
}) {
  const DEFAULT_COOLDOWN = 300;
  const EMERGENCY_COOLDOWN = 60;
  const MAX_JUMP = 30;
  const MIN_CONSECUTIVE = 3;
  const MIN_LEVEL = 20;

  // --- 1. Moving average (InfluxDB) ---
  const queryApi = influx.getQueryApi(process.env.INFLUX_ORG);

  const avgQuery = `
    from(bucket: "${process.env.INFLUX_BUCKET}")
      |> range(start: -5m)
      |> filter(fn: (r) =>
        r._measurement == "water_level" and
        r.location_id == "${location_id}" and
        r._field == "value"
      )
      |> last()
      |> mean()
  `;

  let smoothedLevel = waterLevel;

  try {
    const rows = await queryApi.collectRows(avgQuery);
    if (rows.length && rows[0]._value !== null) {
      smoothedLevel = Math.round(rows[0]._value);
    }
  } catch (e) {
    console.error("Influx AVG error:", e);
  }

  waterLevel = smoothedLevel;

  // --- 2. Threshold logic ---
  let status = null;
  let alertType = null;
  let message = null;

  if (waterLevel >= 100) {
    status = "EMERGENCY";
    alertType = "EMERGENCY";
    message = `WaterSense: Emergency\nWater level is ${waterLevel} cm.\nEVACUATE IMMEDIATELY.`;
  } else if (waterLevel >= 60) {
    status = "DANGER";
    alertType = "DANGER";
    message = `WaterSense: Danger\nWater level is ${waterLevel} cm.`;
  } else if (waterLevel >= 40) {
    status = "WARNING";
    alertType = "WARNING";
    message = `WaterSense: Warning\nWater level is ${waterLevel} cm.`;
  } else if (waterLevel >= 20) {
    status = "CAUTION";
    alertType = "ALERT";
    message = `WaterSense: Alert\nWater level is ${waterLevel} cm.`;
  } else {
    return;
  }

  // --- 3. Cooldown check (PostgreSQL) ---
  const cooldown =
    status === "EMERGENCY"
      ? EMERGENCY_COOLDOWN
      : DEFAULT_COOLDOWN;

  const last = await pool.query(
    `
    SELECT sent_at
    FROM alert_notifications
    WHERE status = $1
    ORDER BY sent_at DESC
    LIMIT 1
    `,
    [status]
  );

  if (last.rows.length && last.rows[0].sent_at) {
    const diff =
      (Date.now() - new Date(last.rows[0].sent_at).getTime()) / 1000;
    if (diff < cooldown) return;
  }

  // --- 4. Queue alerts ---
  await pool.query(
    `
    INSERT INTO alert_notifications
      (subscriber_id, alert_type, water_level_cm, status, channel, message, delivery_status)
    SELECT
      id, $1, $2, $3, 'SMS', $4, 0
    FROM sms_subscribers
    WHERE is_active = TRUE
    `,
    [alertType, waterLevel, status, message]
  );
}




app.get("/api/init-db", async (req, res) => {
  if (process.env.NODE_ENV !== "development") {
    return res.sendStatus(403);
  }
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

app.get("/api/sensors/getCalibration", async (req, res) => {
  const sensorid = parseInt(req.query.sensorid, 10);

  if (!sensorid) {
    return res.status(400).json({ error: "No sensorid provided" });
  }

  try {
    const result = await pool.query(
      `
      SELECT sensorid, calib_offset, calib_scale, updated_at
      FROM sensorsetting
      WHERE sensorid = $1
      `,
      [sensorid]
    );

    // Match original PHP behavior: return array
    res.json(result.rows);
  } catch (err) {
    console.error("GET CALIB ERROR:", err);
    res.status(500).json([]);
  }
});

app.post("/api/sensors/saveCalibration", async (req, res) => {
  const { location_id, offset } = req.body;
  const sensorid = parseInt(location_id, 10);
  const calibOffset = parseFloat(offset);

  if (!sensorid) {
    return res.status(400).json({
      success: false,
      error: "Invalid location"
    });
  }

  try {
    await pool.query(
      `
      INSERT INTO sensorsetting (sensorid, calib_offset, calib_scale, updated_at)
      VALUES ($1, $2, 1, NOW())
      ON CONFLICT (sensorid)
      DO UPDATE SET
        calib_offset = EXCLUDED.calib_offset,
        calib_scale  = 1,
        updated_at   = NOW()
      `,
      [sensorid, calibOffset]
    );

    res.json({
      success: true,
      offset: calibOffset
    });
  } catch (err) {
    console.error("SAVE CALIB ERROR:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.post("/api/ingest", async (req, res) => {
  const {
    api_key,
    location_id,
    water_level,
    battery
  } = req.body;

  // ----------------- API KEY -----------------
  if (api_key !== process.env.ESP_API_KEY) {
    return res.status(401).json({ error: "Wrong API key" });
  }

  let rawWater = parseFloat(water_level);

  // ----------------- CLAMPING -----------------
  if (rawWater < 0) rawWater = 0;
  if (rawWater > 180) rawWater = 180;

  const level = rawWater;

  // ----------------- STATUS -----------------
  let status = "Normal";
  if (level >= 120) status = "Danger";
  else if (level >= 60) status = "Warning";
  else if (level >= 30) status = "Caution";

  // ----------------- INFLUX WRITE -----------------
  try {
    const point = new Point("water_level")
      .tag("location_id", location_id.toString())
      .floatField("value", level)
      .intField("battery", battery ?? 0)
      .stringField("status", status)
      .timestamp(new Date());

    writeApi.writePoint(point);
    await writeApi.flush();
  } catch (err) {
    console.error("Influx write error:", err);
  }

  // ----------------- ALERT ENGINE -----------------
  try {
    await checkAlerts({
      waterLevel: level,
      location_id
    });
  } catch (err) {
    console.error("Alert engine error:", err);
  }

  // ----------------- WEBSOCKET PUSH -----------------
  const payload = {
    location_id,
    water_level_cm: level,
    status,
    battery,
    received_at: new Date().toISOString()
  };

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  });

  res.json({ success: true });
});
app.get("/api/alerts/sms/select", async (req, res) => {
  // Optional kill switch
  if (process.env.SMS_DISABLED === "true") {
    console.log("SMS DISABLED: blocking send");
    return res.json([]);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // STEP 1: lock one pending alert
    const lock = await client.query(`
      UPDATE alert_notifications
      SET delivery_status = 2
      WHERE id = (
        SELECT id
        FROM alert_notifications
        WHERE delivery_status = 0
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE
      )
      RETURNING id
    `);

    if (lock.rowCount !== 1) {
      await client.query("ROLLBACK");
      return res.json([]);
    }

    // STEP 2: fetch locked alert
    const result = await client.query(`
      SELECT
        a.id,
        s.phone_number AS cp_num,
        a.message,
        a.delivery_status
      FROM alert_notifications a
      JOIN sms_subscribers s ON s.id = a.subscriber_id
      WHERE a.delivery_status = 2
        AND s.is_active = TRUE
      ORDER BY a.id ASC
      LIMIT 1
    `);

    await client.query("COMMIT");
    res.json(result.rows);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("SMS SELECT ERROR:", err);
    res.json([]);
  } finally {
    client.release();
  }
});
app.post("/api/alerts/sms/update", async (req, res) => {
  const id = parseInt(req.body.id || req.body.ID, 10);

  if (!id) return res.send("INVALID");

  try {
    const result = await pool.query(`
      UPDATE alert_notifications
      SET
        delivery_status = 1,
        attempt_count = attempt_count + 1,
        sent_at = NOW(),
        error_message = NULL
      WHERE id = $1
        AND delivery_status = 2
    `, [id]);

    res.send(result.rowCount === 1 ? "SENT" : "SKIPPED");
  } catch (err) {
    console.error("SMS UPDATE ERROR:", err);
    res.send("ERROR");
  }
});
app.post("/api/alerts/sms/receive", async (req, res) => {
  const { api_key, device_id, message } = req.body;

  if (api_key !== process.env.ESP_API_KEY || !device_id || !message) {
    return res.json({});
  }

  const text = message.toLowerCase();
  let reply = "";

  if (text === "water sense" || text === "water level") {
    const queryApi = influx.getQueryApi(process.env.INFLUX_ORG);

    const flux = `
      from(bucket: "${process.env.INFLUX_BUCKET}")
        |> range(start: -10m)
        |> filter(fn: (r) =>
          r._measurement == "water_level" and
          r.location_id == "${device_id}" and
          r._field == "value"
        )
        |> last()
    `;

    try {
      const rows = await queryApi.collectRows(flux);
      if (rows.length) {
        reply = `Current water level is ${Math.round(rows[0]._value)} cm.`;
      } else {
        reply = "Water level data is not available yet.";
      }
    } catch (e) {
      console.error("SMS RECEIVE ERROR:", e);
    }
  }

  res.json(reply ? { reply } : {});
});
app.post("/api/alerts/subscribers", async (req, res) => {
  const { phone_number, location = "Barangay Lingga" } = req.body;

  if (!/^09\d{9}$/.test(phone_number)) {
    return res.status(400).json({
      success: false,
      message: "Invalid Philippine mobile number"
    });
  }

  try {
    const existing = await pool.query(
      "SELECT id, is_active FROM sms_subscribers WHERE phone_number = $1",
      [phone_number]
    );

    if (existing.rows.length) {
      const row = existing.rows[0];

      if (row.is_active) {
        return res.json({
          success: true,
          message: "Already subscribed",
          already_subscribed: true
        });
      }

      await pool.query(
        "UPDATE sms_subscribers SET is_active = TRUE, updated_at = NOW() WHERE id = $1",
        [row.id]
      );

      return res.json({
        success: true,
        message: "Subscription reactivated",
        reactivated: true
      });
    }

    const insert = await pool.query(`
      INSERT INTO sms_subscribers
        (phone_number, location, is_active, created_at, updated_at)
      VALUES ($1, $2, TRUE, NOW(), NOW())
      RETURNING id
    `, [phone_number, location]);

    res.json({
      success: true,
      message: "Successfully subscribed",
      subscriber_id: insert.rows[0].id
    });
  } catch (err) {
    console.error("SUBSCRIBE ERROR:", err);
    res.status(500).json({ success: false });
  }
});
app.get("/api/sensors/latest", async (req, res) => {
  try {
    // 1️⃣ Fetch locations + calibration from PostgreSQL
    const locations = await pool.query(`
      SELECT
        l.id AS location_id,
        l.name AS location_name,
        COALESCE(ss.calib_offset, 0) AS calib_offset,
        COALESCE(ss.calib_scale, 1) AS calib_scale,
        ss.updated_at AS calibrated_at
      FROM locations l
      LEFT JOIN sensorsetting ss
        ON ss.sensorid = l.id
    `);

    const queryApi = influx.getQueryApi(process.env.INFLUX_ORG);
    const data = [];

    // 2️⃣ For each location, fetch latest reading from InfluxDB
    for (const loc of locations.rows) {
      const flux = `
        from(bucket: "${process.env.INFLUX_BUCKET}")
          |> range(start: -1d)
          |> filter(fn: (r) =>
            r._measurement == "water_level" and
            r.location_id == "${loc.location_id}"
          )
          |> last()
      `;

      let raw = null;
      let battery = null;
      let created_at = null;

      const rows = await queryApi.collectRows(flux);
      for (const r of rows) {
        if (r._field === "value") raw = r._value;
        if (r._field === "battery") battery = r._value;
        created_at = r._time;
      }

      if (raw === null) continue;

      // 3️⃣ Apply calibration
      let calibrated = raw + loc.calib_offset;

      // Clamp
      calibrated = Math.max(0, Math.min(180, calibrated));

      // 4️⃣ Status logic (same as PHP)
      let status = "Normal";
      if (calibrated >= 120) status = "Danger";
      else if (calibrated >= 60) status = "Warning";
      else if (calibrated >= 30) status = "Caution";

      data.push({
        location_id: loc.location_id,
        location_name: loc.location_name,
        water_level: Number(calibrated.toFixed(1)),
        raw_water_level: Number(raw.toFixed(1)),
        calibration_offset: Number(loc.calib_offset.toFixed(2)),
        calibrated_at: loc.calibrated_at,
        battery,
        status,
        created_at
      });
    }

    res.json(data);
  } catch (err) {
    console.error("LATEST SENSOR ERROR:", err);
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
