const path = require("path");
const express = require("express");
const {
  initDb,
  upsertAttendance,
  upsertUsers,
  getUserCount,
  getAttendance,
  getDailyAttendance,
  getStamps,
  setStamps,
  getLatestPunchedAt,
  getLatestReceivedAt,
  getDashboardStats,
  dbPath,
  usePostgres,
  DEVICE_TZ,
  DISPLAY_TZ,
} = require("./db");
const {
  MANAGER_USERNAME,
  createSessionToken,
  getSession,
  setSessionCookie,
  clearSessionCookie,
  validateCredentials,
  requireAuthApi,
  requireAuthPage,
} = require("./auth");
const { getSettings, updateSettings } = require("./settings");

const app = express();
const PORT = Number(process.env.PORT) || 8080;

app.set("trust proxy", 1);

// Pending ADMS commands per device SN: [{ id, cmd }]
const pendingCommands = new Map();
let nextCommandId = 1;

// Live UI clients (Server-Sent Events)
const liveClients = new Set();

function broadcastLive(event, payload = {}) {
  const data = JSON.stringify({
    type: event,
    at: new Date().toISOString(),
    ...payload,
  });
  for (const client of liveClients) {
    try {
      client.write(`event: ${event}\n`);
      client.write(`data: ${data}\n\n`);
    } catch {
      liveClients.delete(client);
    }
  }
}

// JSON/urlencoded for manager APIs; raw text only for device ADMS posts.
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") && !req.path.startsWith("/api/iclock")) {
    return next();
  }
  return express.text({ type: "*/*", limit: "10mb" })(req, res, next);
});

const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir, { index: false, maxAge: "5m", etag: true }));

app.get("/login", (req, res) => {
  if (getSession(req)) {
    res.redirect("/");
    return;
  }
  res.sendFile(path.join(publicDir, "login.html"));
});

app.get("/", requireAuthPage, (req, res) => {
  res.sendFile(path.join(publicDir, "app.html"));
});

app.get("/attendance", requireAuthPage, (req, res) => {
  res.sendFile(path.join(publicDir, "app.html"));
});

app.get("/settings", requireAuthPage, (req, res) => {
  res.sendFile(path.join(publicDir, "app.html"));
});

app.post("/api/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!validateCredentials(username, password)) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }
  setSessionCookie(res, createSessionToken(username));
  res.json({ success: true, user: { username } });
});

app.post("/api/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

app.get("/api/me", (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  res.json({ user: session });
});

app.get("/api/settings", requireAuthApi, (req, res) => {
  res.json(getSettings());
});

app.put("/api/settings", requireAuthApi, (req, res) => {
  try {
    const updated = updateSettings({
      work_hours: req.body?.work_hours || req.body,
    });
    broadcastLive("settings", { work_hours: updated.work_hours });
    res.json(updated);
  } catch (error) {
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || "Failed to save settings" });
  }
});

const STATUS_LABELS = {
  0: "Check-in",
  1: "Check-out",
  2: "Break-out",
  3: "Break-in",
  4: "OT-in",
  5: "OT-out",
};

const VERIFY_LABELS = {
  0: "Password/other",
  1: "Fingerprint",
  2: "Badge/RF",
  3: "Password",
  4: "Card",
  15: "Face",
};

function countRecords(body) {
  if (!body || typeof body !== "string") return 0;
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function plain(res, body) {
  res.set("Content-Type", "text/plain");
  res.status(200).send(body);
}

function queueCommand(deviceSn, cmd) {
  if (!deviceSn || !cmd) return null;
  const queue = pendingCommands.get(deviceSn) || [];
  // Avoid stacking duplicate user sync requests.
  if (queue.some((item) => item.cmd === cmd)) return null;
  const id = nextCommandId++;
  queue.push({ id, cmd });
  pendingCommands.set(deviceSn, queue);
  return id;
}

function takeCommands(deviceSn) {
  const queue = pendingCommands.get(deviceSn) || [];
  if (!queue.length) return null;
  pendingCommands.set(deviceSn, []);
  return queue.map((item) => `C:${item.id}:${item.cmd}`).join("\n") + "\n";
}

async function ensureUserSync(deviceSn) {
  if (!deviceSn || deviceSn === "UNKNOWN") return;
  const named = await getUserCount(deviceSn, { namedOnly: true });
  if (named > 0) return;
  const id = queueCommand(deviceSn, "DATA QUERY USERINFO");
  if (id) {
    console.log(`[USERS] queued DATA QUERY USERINFO for ${deviceSn} (cmd ${id})`);
  }
}

function parseAttLogLines(deviceSn, body) {
  const receivedAt = new Date().toISOString();
  const rows = [];

  for (const line of String(body || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(/\t/);
    const userPin = (parts[0] || "").trim();
    const punchedAt = (parts[1] || "").trim();
    if (!userPin || !punchedAt) continue;

    rows.push({
      device_sn: deviceSn,
      user_pin: userPin,
      punched_at: punchedAt,
      status: Number(parts[2] ?? 0) || 0,
      verify_type: Number(parts[3] ?? 0) || 0,
      work_code: parts[4] != null ? String(parts[4]) : null,
      raw_line: trimmed,
      received_at: receivedAt,
    });
  }

  return rows;
}

function parseKeyValueFields(text) {
  const fields = {};
  const normalized = String(text || "")
    .replace(/^USER\s+/i, "")
    .replace(/^USERINFO\s+/i, "");

  for (const token of normalized.split(/[\t\s]+/)) {
    const idx = token.indexOf("=");
    if (idx <= 0) continue;
    const key = token.slice(0, idx).trim();
    const value = token.slice(idx + 1).trim();
    if (key) fields[key] = value;
  }
  return fields;
}

function parseUserLines(deviceSn, body) {
  const updatedAt = new Date().toISOString();
  const rows = [];

  for (const line of String(body || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const upper = trimmed.toUpperCase();
    // Fingerprint templates look like "FP PIN=..." — ignore those.
    if (upper.startsWith("FP ") || upper.startsWith("FP\t")) continue;
    if (upper.startsWith("OPLOG")) continue;

    const isUserPrefix =
      upper.startsWith("USER ") ||
      upper.startsWith("USER\t") ||
      upper.startsWith("USERINFO");
    const isKeyValueUser =
      /(^|\t)PIN=/i.test(trimmed) && /(^|\t)Name=/i.test(trimmed);

    if (!isUserPrefix && !isKeyValueUser) continue;

    const fields = parseKeyValueFields(trimmed);
    const userPin = (fields.PIN || fields.Pin || fields.pin || "").trim();
    if (!userPin) continue;

    const userName = (fields.Name || fields.NAME || fields.name || "").trim();
    rows.push({
      device_sn: deviceSn,
      user_pin: userPin,
      user_name: userName,
      privilege: Number(fields.Pri ?? fields.Privilege ?? 0) || 0,
      card: fields.Card || fields.card || null,
      raw_line: trimmed.slice(0, 500),
      updated_at: updatedAt,
    });
  }

  return rows;
}

function advanceStamp(storedStamp, incomingStamp, count) {
  const stored = Number(storedStamp) || 0;
  const incoming = Number(incomingStamp);
  if (!Number.isNaN(incoming) && incoming > 0 && incoming < 9999) {
    return Math.max(stored, incoming + count);
  }
  return stored + count;
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// --- ADMS endpoints ---

app.get(
  "/iclock/cdata",
  asyncRoute(async (req, res) => {
    const sn = req.query.SN || "UNKNOWN";
    const stamps = await getStamps(sn);
    await ensureUserSync(sn);

    console.log(`[ADMS] handshake SN=${sn} Stamp=${stamps.attlog} OpStamp=${stamps.operlog}`);

    const options = [
      `GET OPTION FROM: ${sn}`,
      `Stamp=${stamps.attlog}`,
      `OpStamp=${stamps.operlog}`,
      `ATTLOGStamp=${stamps.attlog}`,
      `OPERLOGStamp=${stamps.operlog}`,
      "ErrorDelay=60",
      "Delay=30",
      "TransTimes=00:00;14:00",
      "TransInterval=1",
      "TransFlag=TransData AttLog OpLog AttPhoto EnrollUser ChgUser EnrollFP ChgFP",
      "Realtime=1",
      "Encrypt=0",
      "TimeZone=0",
    ].join("\n");

    plain(res, options);
  })
);

app.post(
  "/iclock/cdata",
  asyncRoute(async (req, res) => {
    const sn = req.query.SN || "UNKNOWN";
    const table = (req.query.table || "").toUpperCase();
    const body = typeof req.body === "string" ? req.body : "";
    const count = countRecords(body);
    const stamps = await getStamps(sn);

    await ensureUserSync(sn);

    if (table === "ATTLOG") {
      const rows = parseAttLogLines(sn, body);
      const inserted = await upsertAttendance(rows);
      const nextStamp = advanceStamp(stamps.attlog, req.query.Stamp, count);
      await setStamps(sn, { attlog: nextStamp });

      console.log(
        `[ATTLOG] SN=${sn} received=${rows.length} inserted=${inserted} stamp=${nextStamp}`
      );
      for (const row of rows) {
        const status = STATUS_LABELS[row.status] || `Status ${row.status}`;
        const verify = VERIFY_LABELS[row.verify_type] || `Verify ${row.verify_type}`;
        console.log(`  -> PIN ${row.user_pin} @ ${row.punched_at} (${status}, ${verify})`);
      }

      broadcastLive("attendance", {
        sn,
        inserted,
        received: rows.length,
        punches: rows.map((row) => ({
          user_pin: row.user_pin,
          punched_at: row.punched_at,
        })),
      });
    } else if (table === "OPERLOG") {
      const users = parseUserLines(sn, body);
      if (users.length) {
        const saved = await upsertUsers(users);
        console.log(`[USERS] SN=${sn} saved=${saved} from OPERLOG`);
        for (const user of users.slice(0, 10)) {
          console.log(`  -> PIN ${user.user_pin} Name=${user.user_name || "(blank)"}`);
        }
        broadcastLive("users", { sn, saved });
      }

      const nextStamp = advanceStamp(
        stamps.operlog,
        req.query.OpStamp ?? req.query.Stamp,
        count
      );
      await setStamps(sn, { operlog: nextStamp });
      console.log(`[OPERLOG] SN=${sn} ack=${count} OpStamp=${nextStamp}`);
    } else if (table === "USERINFO" || table === "USER" || !table) {
      const users = parseUserLines(sn, body);
      if (users.length) {
        const saved = await upsertUsers(users);
        console.log(`[USERS] SN=${sn} saved=${saved} from ${table || "cdata"}`);
        for (const user of users.slice(0, 20)) {
          console.log(`  -> PIN ${user.user_pin} Name=${user.user_name || "(blank)"}`);
        }
        broadcastLive("users", { sn, saved });
      } else {
        console.log(`[ADMS] POST table=${table || "(none)"} SN=${sn} lines=${count}`);
      }
    } else {
      const users = parseUserLines(sn, body);
      if (users.length) {
        const saved = await upsertUsers(users);
        console.log(`[USERS] SN=${sn} saved=${saved} from ${table}`);
        broadcastLive("users", { sn, saved });
      } else {
        console.log(`[ADMS] POST table=${table || "(none)"} SN=${sn} lines=${count}`);
      }
    }

    plain(res, `OK: ${count}`);
  })
);

app.get(
  "/iclock/getrequest",
  asyncRoute(async (req, res) => {
    const sn = req.query.SN || "UNKNOWN";
    await ensureUserSync(sn);
    const commands = takeCommands(sn);
    if (commands) {
      console.log(`[ADMS] sending commands to ${sn}:\n${commands.trim()}`);
      plain(res, commands);
      return;
    }
    plain(res, "OK");
  })
);

app.post("/iclock/devicecmd", (req, res) => {
  console.log(`[ADMS] device command result SN=${req.query.SN || "UNKNOWN"} body=${req.body}`);
  plain(res, "OK");
});

app.post("/api/sync-users", requireAuthApi, (req, res) => {
  const sn = req.query.sn || req.body?.sn;
  if (!sn) {
    res.status(400).json({ error: "Provide ?sn=DEVICE_SERIAL" });
    return;
  }
  const id = queueCommand(sn, "DATA QUERY USERINFO");
  res.json({
    ok: true,
    queued: Boolean(id),
    command_id: id,
    message: id
      ? "User sync queued. Clock in or wait for the next device heartbeat."
      : "User sync already queued.",
  });
});

// --- Attendance API ---

app.get("/api/events", requireAuthApi, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({ ok: true, clients: liveClients.size + 1 })}\n\n`);

  liveClients.add(res);
  console.log(`[LIVE] client connected (${liveClients.size})`);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      clearInterval(heartbeat);
      liveClients.delete(res);
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    liveClients.delete(res);
    console.log(`[LIVE] client disconnected (${liveClients.size})`);
  });
});

function attendanceFilters(query) {
  return {
    from: query.from || undefined,
    to: query.to || undefined,
    pin: query.pin || undefined,
    sn: query.sn || undefined,
    limit: query.limit,
    offset: query.offset,
  };
}

app.get(
  "/api/dashboard",
  requireAuthApi,
  asyncRoute(async (req, res) => {
    const data = await getDashboardStats();
    res.json(data);
  })
);

app.get(
  "/api/attendance",
  requireAuthApi,
  asyncRoute(async (req, res) => {
    const filters = attendanceFilters(req.query);
    const result = await getDailyAttendance(filters);
    res.json({
      total: result.total,
      latest_received_at: await getLatestReceivedAt(),
      latest_punched_at: await getLatestPunchedAt(),
      users_known: await getUserCount(req.query.sn),
      mode: "daily",
      rows: result.rows,
    });
  })
);

app.get(
  "/api/attendance/raw",
  requireAuthApi,
  asyncRoute(async (req, res) => {
    const result = await getAttendance(attendanceFilters(req.query));
    res.json({
      total: result.total,
      rows: result.rows.map((row) => ({
        ...row,
        status_label: STATUS_LABELS[row.status] || `Status ${row.status}`,
        verify_label: VERIFY_LABELS[row.verify_type] || `Verify ${row.verify_type}`,
      })),
    });
  })
);

app.get(
  "/api/attendance.csv",
  requireAuthApi,
  asyncRoute(async (req, res) => {
    const result = await getDailyAttendance({
      ...attendanceFilters(req.query),
      limit: req.query.limit || 5000,
      offset: 0,
    });

    const header = [
      "work_date",
      "user_id",
      "user_name",
      "check_in",
      "check_out",
      "punch_count",
      "status",
    ];

    const lines = [header.join(",")];
    for (const row of result.rows) {
      lines.push(
        [
          row.work_date,
          row.user_pin,
          row.user_name,
          row.check_in_time || "",
          row.check_out_time || "",
          row.punch_count,
          row.status_label,
        ]
          .map(csvEscape)
          .join(",")
      );
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="attendance-daily-${stamp}.csv"`,
    });
    res.status(200).send(lines.join("\n"));
  })
);

app.use((error, req, res, next) => {
  console.error("[ERROR]", error);
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(500).json({ error: "Internal server error" });
});

async function start() {
  await initDb();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`ADMS + Attendance UI on http://0.0.0.0:${PORT}`);
    console.log(`UI: http://127.0.0.1:${PORT}/`);
    console.log(`Live updates: http://127.0.0.1:${PORT}/api/events`);
    console.log(`Database: ${usePostgres ? "Postgres (DATABASE_URL)" : `SQLite ${dbPath}`}`);
    console.log(`Timezone: device=${DEVICE_TZ} → display=${DISPLAY_TZ}`);
    console.log(`Manager login user: ${MANAGER_USERNAME}`);
  });
}

start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
