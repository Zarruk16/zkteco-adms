const fs = require("fs");
const path = require("path");

const settingsPath = path.join(__dirname, "data", "settings.json");

const DEFAULT_WORK_HOURS = {
  work_start: process.env.WORK_START || "08:00",
  late_after: process.env.LATE_AFTER || "09:00",
  early_leave_before: process.env.EARLY_LEAVE_BEFORE || "16:00",
  work_end: process.env.WORK_END || "17:00",
};

let cache = null;

function ensureDataDir() {
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isValidHhMm(value) {
  return /^([01]?\d|2[0-3]):([0-5]\d)$/.test(String(value || "").trim());
}

function normalizeHhMm(value) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
  if (!match) return String(value || "").trim();
  return `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`;
}

function normalizeWorkHours(input = {}) {
  const next = {
    work_start: normalizeHhMm(input.work_start || DEFAULT_WORK_HOURS.work_start),
    late_after: normalizeHhMm(input.late_after || DEFAULT_WORK_HOURS.late_after),
    early_leave_before: normalizeHhMm(input.early_leave_before || DEFAULT_WORK_HOURS.early_leave_before),
    work_end: normalizeHhMm(input.work_end || DEFAULT_WORK_HOURS.work_end),
  };

  for (const [key, value] of Object.entries(next)) {
    if (!isValidHhMm(value)) {
      const error = new Error(`Invalid time for ${key}. Use HH:MM (24-hour).`);
      error.statusCode = 400;
      throw error;
    }
  }

  const toMinutes = (value) => {
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
  };

  if (toMinutes(next.work_start) > toMinutes(next.late_after)) {
    const error = new Error("Grace period (late after) must be at or after work start.");
    error.statusCode = 400;
    throw error;
  }
  if (toMinutes(next.early_leave_before) > toMinutes(next.work_end)) {
    const error = new Error("Early leave cutoff must be at or before work end.");
    error.statusCode = 400;
    throw error;
  }
  if (toMinutes(next.work_start) >= toMinutes(next.work_end)) {
    const error = new Error("Work end must be after work start.");
    error.statusCode = 400;
    throw error;
  }

  return next;
}

function readSettingsFile() {
  ensureDataDir();
  if (!fs.existsSync(settingsPath)) {
    const initial = {
      work_hours: { ...DEFAULT_WORK_HOURS },
      updated_at: null,
    };
    fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return {
      work_hours: normalizeWorkHours(parsed.work_hours || DEFAULT_WORK_HOURS),
      updated_at: parsed.updated_at || null,
    };
  } catch {
    return {
      work_hours: { ...DEFAULT_WORK_HOURS },
      updated_at: null,
    };
  }
}

function getSettings() {
  if (!cache) cache = readSettingsFile();
  return {
    work_hours: { ...cache.work_hours },
    updated_at: cache.updated_at,
  };
}

function getWorkHours() {
  return getSettings().work_hours;
}

function updateSettings({ work_hours } = {}) {
  const next = {
    work_hours: normalizeWorkHours(work_hours || getWorkHours()),
    updated_at: new Date().toISOString(),
  };
  ensureDataDir();
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2));
  cache = next;
  return getSettings();
}

module.exports = {
  getSettings,
  getWorkHours,
  updateSettings,
  settingsPath,
};
