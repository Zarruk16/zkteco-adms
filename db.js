const fs = require("fs");
const path = require("path");

const usePostgres = Boolean(process.env.DATABASE_URL);
const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "attendance.db");

let driver = null;
let db = null;

function formatTime12Hour(dateTime) {
  if (!dateTime) return null;
  const match = String(dateTime).match(/(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return String(dateTime);

  let hour = Number(match[1]);
  const minute = match[2];
  const second = match[3] || "00";
  const suffix = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute}:${second} ${suffix}`;
}

function buildDailyWhere({ from, to, pin, sn } = {}) {
  const where = [];
  const params = {};

  if (from) {
    where.push("date(a.punched_at) >= @fromDate");
    params.fromDate = String(from).slice(0, 10);
  }
  if (to) {
    where.push("date(a.punched_at) <= @toDate");
    params.toDate = String(to).slice(0, 10);
  }
  if (pin) {
    where.push("a.user_pin = @pin");
    params.pin = String(pin);
  }
  if (sn) {
    where.push("a.device_sn = @sn");
    params.sn = String(sn);
  }

  return {
    clause: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

function pairSessions(punches) {
  const sessions = [];
  const openByKey = new Map();

  for (const punch of punches) {
    const key = `${punch.work_date}|${punch.device_sn}|${punch.user_pin}`;
    const open = openByKey.get(key);

    if (!open) {
      const session = {
        work_date: punch.work_date,
        device_sn: punch.device_sn,
        user_pin: punch.user_pin,
        user_name: punch.user_name || "",
        check_in: punch.punched_at,
        check_out: null,
        punch_count: 1,
        received_at: punch.received_at,
        last_punch: punch.punched_at,
      };
      sessions.push(session);
      openByKey.set(key, session);
      continue;
    }

    open.check_out = punch.punched_at;
    open.punch_count = 2;
    open.received_at = punch.received_at;
    open.last_punch = punch.punched_at;
    if (punch.user_name) open.user_name = punch.user_name;
    openByKey.delete(key);
  }

  sessions.sort((a, b) => {
    const byReceived = String(b.received_at || "").localeCompare(String(a.received_at || ""));
    if (byReceived !== 0) return byReceived;
    return String(b.last_punch || "").localeCompare(String(a.last_punch || ""));
  });

  return sessions;
}

function mapDailyRows(sessions, safeOffset, safeLimit) {
  const total = sessions.length;
  const rows = sessions.slice(safeOffset, safeOffset + safeLimit).map((row) => ({
    ...row,
    check_in_time: formatTime12Hour(row.check_in),
    check_out_time: formatTime12Hour(row.check_out),
    status_label: row.check_out ? "Complete" : "Checked in",
  }));
  return { rows, total };
}

function createSqliteDriver() {
  const Database = require("better-sqlite3");

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_sn TEXT NOT NULL,
      user_pin TEXT NOT NULL,
      punched_at TEXT NOT NULL,
      status INTEGER NOT NULL DEFAULT 0,
      verify_type INTEGER NOT NULL DEFAULT 0,
      work_code TEXT,
      raw_line TEXT,
      received_at TEXT NOT NULL,
      UNIQUE(device_sn, user_pin, punched_at, status, verify_type)
    );

    CREATE INDEX IF NOT EXISTS idx_attendance_punched_at ON attendance(punched_at);
    CREATE INDEX IF NOT EXISTS idx_attendance_user_pin ON attendance(user_pin);

    CREATE TABLE IF NOT EXISTS device_stamps (
      device_sn TEXT PRIMARY KEY,
      attlog_stamp INTEGER NOT NULL DEFAULT 0,
      operlog_stamp INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      device_sn TEXT NOT NULL,
      user_pin TEXT NOT NULL,
      user_name TEXT NOT NULL DEFAULT '',
      privilege INTEGER NOT NULL DEFAULT 0,
      card TEXT,
      raw_line TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (device_sn, user_pin)
    );

    CREATE INDEX IF NOT EXISTS idx_users_name ON users(user_name);
  `);

  sqlite
    .prepare(
      `DELETE FROM users WHERE user_name = '' AND (raw_line LIKE 'FP %' OR raw_line LIKE 'FP\t%')`
    )
    .run();

  const insertAttendance = sqlite.prepare(`
    INSERT OR IGNORE INTO attendance (
      device_sn, user_pin, punched_at, status, verify_type, work_code, raw_line, received_at
    ) VALUES (
      @device_sn, @user_pin, @punched_at, @status, @verify_type, @work_code, @raw_line, @received_at
    )
  `);

  const upsertUserStmt = sqlite.prepare(`
    INSERT INTO users (
      device_sn, user_pin, user_name, privilege, card, raw_line, updated_at
    ) VALUES (
      @device_sn, @user_pin, @user_name, @privilege, @card, @raw_line, @updated_at
    )
    ON CONFLICT(device_sn, user_pin) DO UPDATE SET
      user_name = CASE
        WHEN excluded.user_name != '' THEN excluded.user_name
        ELSE users.user_name
      END,
      privilege = excluded.privilege,
      card = COALESCE(excluded.card, users.card),
      raw_line = excluded.raw_line,
      updated_at = excluded.updated_at
  `);

  return {
    kind: "sqlite",
    db: sqlite,
    async upsertAttendance(rows) {
      if (!rows || rows.length === 0) return 0;
      let inserted = 0;
      const tx = sqlite.transaction((items) => {
        for (const row of items) {
          const result = insertAttendance.run(row);
          if (result.changes > 0) inserted += 1;
        }
      });
      tx(rows);
      return inserted;
    },
    async upsertUsers(rows) {
      if (!rows || rows.length === 0) return 0;
      let upserted = 0;
      const tx = sqlite.transaction((items) => {
        for (const row of items) {
          const result = upsertUserStmt.run(row);
          if (result.changes > 0) upserted += 1;
        }
      });
      tx(rows);
      return upserted;
    },
    async getUserCount(deviceSn, { namedOnly = false } = {}) {
      if (deviceSn) {
        if (namedOnly) {
          return sqlite
            .prepare(
              `SELECT COUNT(*) AS count FROM users WHERE device_sn = ? AND TRIM(user_name) != ''`
            )
            .get(deviceSn).count;
        }
        return sqlite.prepare(`SELECT COUNT(*) AS count FROM users WHERE device_sn = ?`).get(deviceSn)
          .count;
      }
      if (namedOnly) {
        return sqlite
          .prepare(`SELECT COUNT(*) AS count FROM users WHERE TRIM(user_name) != ''`)
          .get().count;
      }
      return sqlite.prepare(`SELECT COUNT(*) AS count FROM users`).get().count;
    },
    async getStamps(deviceSn) {
      const row = sqlite
        .prepare(`SELECT attlog_stamp, operlog_stamp FROM device_stamps WHERE device_sn = ?`)
        .get(deviceSn);
      return {
        attlog: row ? row.attlog_stamp : 0,
        operlog: row ? row.operlog_stamp : 0,
      };
    },
    async setStamps(deviceSn, { attlog, operlog } = {}) {
      const current = await this.getStamps(deviceSn);
      const nextAtt = attlog !== undefined ? attlog : current.attlog;
      const nextOp = operlog !== undefined ? operlog : current.operlog;
      const updatedAt = new Date().toISOString();

      sqlite
        .prepare(
          `
          INSERT INTO device_stamps (device_sn, attlog_stamp, operlog_stamp, updated_at)
          VALUES (@device_sn, @attlog_stamp, @operlog_stamp, @updated_at)
          ON CONFLICT(device_sn) DO UPDATE SET
            attlog_stamp = excluded.attlog_stamp,
            operlog_stamp = excluded.operlog_stamp,
            updated_at = excluded.updated_at
        `
        )
        .run({
          device_sn: deviceSn,
          attlog_stamp: nextAtt,
          operlog_stamp: nextOp,
          updated_at: updatedAt,
        });

      return { attlog: nextAtt, operlog: nextOp };
    },
    async getAttendance({ from, to, pin, sn, limit = 200, offset = 0 } = {}) {
      const where = [];
      const params = {};

      if (from) {
        where.push("date(a.received_at) >= @fromDate");
        params.fromDate = String(from).slice(0, 10);
      }
      if (to) {
        where.push("date(a.received_at) <= @toDate");
        params.toDate = String(to).slice(0, 10);
      }
      if (pin) {
        where.push("a.user_pin = @pin");
        params.pin = String(pin);
      }
      if (sn) {
        where.push("a.device_sn = @sn");
        params.sn = String(sn);
      }

      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 5000);
      const safeOffset = Math.max(Number(offset) || 0, 0);

      const rows = sqlite
        .prepare(
          `
          SELECT
            a.id,
            a.device_sn,
            a.user_pin,
            COALESCE(NULLIF(u.user_name, ''), '') AS user_name,
            a.punched_at,
            a.status,
            a.verify_type,
            a.work_code,
            a.received_at
          FROM attendance a
          LEFT JOIN users u
            ON u.device_sn = a.device_sn AND u.user_pin = a.user_pin
          ${clause}
          ORDER BY a.received_at DESC, a.id DESC
          LIMIT ${safeLimit} OFFSET ${safeOffset}
        `
        )
        .all(params);

      const total = sqlite.prepare(`SELECT COUNT(*) AS count FROM attendance a ${clause}`).get(params)
        .count;

      return { rows, total };
    },
    async getDailyAttendance({ from, to, pin, sn, limit = 200, offset = 0 } = {}) {
      const { clause, params } = buildDailyWhere({ from, to, pin, sn });
      const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 5000);
      const safeOffset = Math.max(Number(offset) || 0, 0);

      const punches = sqlite
        .prepare(
          `
          SELECT
            date(a.punched_at) AS work_date,
            a.device_sn,
            a.user_pin,
            COALESCE(NULLIF(u.user_name, ''), '') AS user_name,
            a.punched_at,
            a.received_at,
            a.id
          FROM attendance a
          LEFT JOIN users u
            ON u.device_sn = a.device_sn AND u.user_pin = a.user_pin
          ${clause}
          ORDER BY a.punched_at ASC, a.id ASC
        `
        )
        .all(params);

      return mapDailyRows(pairSessions(punches), safeOffset, safeLimit);
    },
    async getLatestReceivedAt() {
      const row = sqlite
        .prepare(`SELECT received_at FROM attendance ORDER BY received_at DESC, id DESC LIMIT 1`)
        .get();
      return row?.received_at || null;
    },
    async getLatestPunchedAt() {
      const row = sqlite
        .prepare(`SELECT punched_at FROM attendance ORDER BY punched_at DESC, id DESC LIMIT 1`)
        .get();
      return row?.punched_at || null;
    },
  };
}

function pgSslConfig() {
  if (process.env.PGSSLMODE === "disable") return false;
  return { rejectUnauthorized: false };
}

function buildPgDailyWhere({ from, to, pin, sn } = {}) {
  const where = [];
  const params = [];
  let index = 1;

  if (from) {
    where.push(`DATE(a.punched_at) >= $${index++}`);
    params.push(String(from).slice(0, 10));
  }
  if (to) {
    where.push(`DATE(a.punched_at) <= $${index++}`);
    params.push(String(to).slice(0, 10));
  }
  if (pin) {
    where.push(`a.user_pin = $${index++}`);
    params.push(String(pin));
  }
  if (sn) {
    where.push(`a.device_sn = $${index++}`);
    params.push(String(sn));
  }

  return {
    clause: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

function buildPgAttendanceWhere({ from, to, pin, sn } = {}) {
  const where = [];
  const params = [];
  let index = 1;

  if (from) {
    where.push(`DATE(a.received_at) >= $${index++}`);
    params.push(String(from).slice(0, 10));
  }
  if (to) {
    where.push(`DATE(a.received_at) <= $${index++}`);
    params.push(String(to).slice(0, 10));
  }
  if (pin) {
    where.push(`a.user_pin = $${index++}`);
    params.push(String(pin));
  }
  if (sn) {
    where.push(`a.device_sn = $${index++}`);
    params.push(String(sn));
  }

  return {
    clause: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

async function createPostgresDriver() {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: pgSslConfig(),
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY,
      device_sn TEXT NOT NULL,
      user_pin TEXT NOT NULL,
      punched_at TEXT NOT NULL,
      status INTEGER NOT NULL DEFAULT 0,
      verify_type INTEGER NOT NULL DEFAULT 0,
      work_code TEXT,
      raw_line TEXT,
      received_at TEXT NOT NULL,
      UNIQUE(device_sn, user_pin, punched_at, status, verify_type)
    );

    CREATE INDEX IF NOT EXISTS idx_attendance_punched_at ON attendance(punched_at);
    CREATE INDEX IF NOT EXISTS idx_attendance_user_pin ON attendance(user_pin);

    CREATE TABLE IF NOT EXISTS device_stamps (
      device_sn TEXT PRIMARY KEY,
      attlog_stamp INTEGER NOT NULL DEFAULT 0,
      operlog_stamp INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      device_sn TEXT NOT NULL,
      user_pin TEXT NOT NULL,
      user_name TEXT NOT NULL DEFAULT '',
      privilege INTEGER NOT NULL DEFAULT 0,
      card TEXT,
      raw_line TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (device_sn, user_pin)
    );

    CREATE INDEX IF NOT EXISTS idx_users_name ON users(user_name);
  `);

  await pool.query(
    `DELETE FROM users WHERE user_name = '' AND (raw_line LIKE 'FP %' OR raw_line LIKE 'FP' || CHR(9) || '%')`
  );

  return {
    kind: "postgres",
    pool,
    async upsertAttendance(rows) {
      if (!rows || rows.length === 0) return 0;
      const client = await pool.connect();
      let inserted = 0;
      try {
        await client.query("BEGIN");
        for (const row of rows) {
          const result = await client.query(
            `
            INSERT INTO attendance (
              device_sn, user_pin, punched_at, status, verify_type, work_code, raw_line, received_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (device_sn, user_pin, punched_at, status, verify_type) DO NOTHING
          `,
            [
              row.device_sn,
              row.user_pin,
              row.punched_at,
              row.status,
              row.verify_type,
              row.work_code,
              row.raw_line,
              row.received_at,
            ]
          );
          inserted += result.rowCount;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return inserted;
    },
    async upsertUsers(rows) {
      if (!rows || rows.length === 0) return 0;
      const client = await pool.connect();
      let upserted = 0;
      try {
        await client.query("BEGIN");
        for (const row of rows) {
          const result = await client.query(
            `
            INSERT INTO users (
              device_sn, user_pin, user_name, privilege, card, raw_line, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (device_sn, user_pin) DO UPDATE SET
              user_name = CASE
                WHEN EXCLUDED.user_name != '' THEN EXCLUDED.user_name
                ELSE users.user_name
              END,
              privilege = EXCLUDED.privilege,
              card = COALESCE(EXCLUDED.card, users.card),
              raw_line = EXCLUDED.raw_line,
              updated_at = EXCLUDED.updated_at
          `,
            [
              row.device_sn,
              row.user_pin,
              row.user_name,
              row.privilege,
              row.card,
              row.raw_line,
              row.updated_at,
            ]
          );
          upserted += result.rowCount;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return upserted;
    },
    async getUserCount(deviceSn, { namedOnly = false } = {}) {
      if (deviceSn) {
        if (namedOnly) {
          const result = await pool.query(
            `SELECT COUNT(*)::int AS count FROM users WHERE device_sn = $1 AND TRIM(user_name) != ''`,
            [deviceSn]
          );
          return result.rows[0].count;
        }
        const result = await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE device_sn = $1`, [
          deviceSn,
        ]);
        return result.rows[0].count;
      }
      if (namedOnly) {
        const result = await pool.query(
          `SELECT COUNT(*)::int AS count FROM users WHERE TRIM(user_name) != ''`
        );
        return result.rows[0].count;
      }
      const result = await pool.query(`SELECT COUNT(*)::int AS count FROM users`);
      return result.rows[0].count;
    },
    async getStamps(deviceSn) {
      const result = await pool.query(
        `SELECT attlog_stamp, operlog_stamp FROM device_stamps WHERE device_sn = $1`,
        [deviceSn]
      );
      const row = result.rows[0];
      return {
        attlog: row ? row.attlog_stamp : 0,
        operlog: row ? row.operlog_stamp : 0,
      };
    },
    async setStamps(deviceSn, { attlog, operlog } = {}) {
      const current = await this.getStamps(deviceSn);
      const nextAtt = attlog !== undefined ? attlog : current.attlog;
      const nextOp = operlog !== undefined ? operlog : current.operlog;
      const updatedAt = new Date().toISOString();

      await pool.query(
        `
        INSERT INTO device_stamps (device_sn, attlog_stamp, operlog_stamp, updated_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (device_sn) DO UPDATE SET
          attlog_stamp = EXCLUDED.attlog_stamp,
          operlog_stamp = EXCLUDED.operlog_stamp,
          updated_at = EXCLUDED.updated_at
      `,
        [deviceSn, nextAtt, nextOp, updatedAt]
      );

      return { attlog: nextAtt, operlog: nextOp };
    },
    async getAttendance({ from, to, pin, sn, limit = 200, offset = 0 } = {}) {
      const { clause, params } = buildPgAttendanceWhere({ from, to, pin, sn });
      const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 5000);
      const safeOffset = Math.max(Number(offset) || 0, 0);

      const rowsResult = await pool.query(
        `
        SELECT
          a.id,
          a.device_sn,
          a.user_pin,
          COALESCE(NULLIF(u.user_name, ''), '') AS user_name,
          a.punched_at,
          a.status,
          a.verify_type,
          a.work_code,
          a.received_at
        FROM attendance a
        LEFT JOIN users u
          ON u.device_sn = a.device_sn AND u.user_pin = a.user_pin
        ${clause}
        ORDER BY a.received_at DESC, a.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
        [...params, safeLimit, safeOffset]
      );

      const totalResult = await pool.query(
        `SELECT COUNT(*)::int AS count FROM attendance a ${clause}`,
        params
      );

      return { rows: rowsResult.rows, total: totalResult.rows[0].count };
    },
    async getDailyAttendance({ from, to, pin, sn, limit = 200, offset = 0 } = {}) {
      const { clause, params } = buildPgDailyWhere({ from, to, pin, sn });
      const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 5000);
      const safeOffset = Math.max(Number(offset) || 0, 0);

      const punchesResult = await pool.query(
        `
        SELECT
          DATE(a.punched_at)::text AS work_date,
          a.device_sn,
          a.user_pin,
          COALESCE(NULLIF(u.user_name, ''), '') AS user_name,
          a.punched_at,
          a.received_at,
          a.id
        FROM attendance a
        LEFT JOIN users u
          ON u.device_sn = a.device_sn AND u.user_pin = a.user_pin
        ${clause}
        ORDER BY a.punched_at ASC, a.id ASC
      `,
        params
      );

      return mapDailyRows(pairSessions(punchesResult.rows), safeOffset, safeLimit);
    },
    async getLatestReceivedAt() {
      const result = await pool.query(
        `SELECT received_at FROM attendance ORDER BY received_at DESC, id DESC LIMIT 1`
      );
      return result.rows[0]?.received_at || null;
    },
    async getLatestPunchedAt() {
      const result = await pool.query(
        `SELECT punched_at FROM attendance ORDER BY punched_at DESC, id DESC LIMIT 1`
      );
      return result.rows[0]?.punched_at || null;
    },
  };
}

async function initDb() {
  if (driver) return driver;
  driver = usePostgres ? await createPostgresDriver() : createSqliteDriver();
  db = driver.db || driver.pool || null;
  return driver;
}

function requireDriver() {
  if (!driver) {
    throw new Error("Database not initialized. Call initDb() before using the database.");
  }
  return driver;
}

async function upsertAttendance(rows) {
  return requireDriver().upsertAttendance(rows);
}

async function upsertUsers(rows) {
  return requireDriver().upsertUsers(rows);
}

async function getUserCount(deviceSn, options) {
  return requireDriver().getUserCount(deviceSn, options);
}

async function getAttendance(filters) {
  return requireDriver().getAttendance(filters);
}

async function getDailyAttendance(filters) {
  return requireDriver().getDailyAttendance(filters);
}

async function getStamps(deviceSn) {
  return requireDriver().getStamps(deviceSn);
}

async function setStamps(deviceSn, stamps) {
  return requireDriver().setStamps(deviceSn, stamps);
}

async function getLatestPunchedAt() {
  return requireDriver().getLatestPunchedAt();
}

async function getLatestReceivedAt() {
  return requireDriver().getLatestReceivedAt();
}

module.exports = {
  db,
  dbPath,
  initDb,
  usePostgres,
  upsertAttendance,
  upsertUsers,
  getUserCount,
  getAttendance,
  getDailyAttendance,
  getStamps,
  setStamps,
  getLatestPunchedAt,
  getLatestReceivedAt,
};
