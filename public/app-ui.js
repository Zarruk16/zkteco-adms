const state = {
  currentView: null,
  dashboardLoaded: false,
  attendanceLoaded: false,
  settingsLoaded: false,
  dashboardLoading: false,
  attendanceLoading: false,
  settingsLoading: false,
  latestPunchedAt: null,
  currentPage: 1,
  totalRows: 0,
  eventSource: null,
  workHours: null,
};

const PAGE_SIZES = [10, 15, 20, 25, 50];
const peopleRows = document.getElementById("peopleRows");
const rowsEl = document.getElementById("rows");
const filtersForm = document.getElementById("filters");
const pageSizeEl = document.getElementById("pageSize");
const pageInfoEl = document.getElementById("pageInfo");
const prevPageBtn = document.getElementById("prevPage");
const nextPageBtn = document.getElementById("nextPage");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function initials(name, pin) {
  const letters = String(name || "")
    .replace(/[^a-zA-Z ]/g, "")
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2);
  return (letters || String(pin || "U").slice(-2)).toUpperCase();
}

async function ensureAuth(response) {
  if (response.status === 401) {
    sessionStorage.removeItem("wa_manager_username");
    window.location.href = "/login";
    return false;
  }
  return true;
}

function statusBadges(row) {
  const badges = [];
  if (row.late) badges.push(`<span class="badge badge-late">Late</span>`);
  if (row.left_early) badges.push(`<span class="badge badge-early">Left early</span>`);
  if (!badges.length) {
    badges.push(
      row.punch_count > 1
        ? `<span class="badge badge-ok">Complete</span>`
        : `<span class="badge badge-in">Checked in</span>`
    );
  }
  return `<div class="badge-row">${badges.join("")}</div>`;
}

function userCell(row) {
  return `<div class="user-cell">
    <span class="user-initial">${escapeHtml(initials(row.user_name, row.user_pin))}</span>
    <span class="user-meta"><strong>${escapeHtml(row.user_name || "Unnamed user")}</strong><small>ID ${escapeHtml(row.user_pin)}</small></span>
  </div>`;
}

function viewFromPath(pathname = window.location.pathname) {
  if (pathname === "/attendance") return "attendance";
  if (pathname === "/settings") return "settings";
  return "dashboard";
}

function pathForView(view) {
  if (view === "attendance") return "/attendance";
  if (view === "settings") return "/settings";
  return "/";
}

function titleForView(view) {
  if (view === "attendance") return "Attendance";
  if (view === "settings") return "Settings";
  return "Dashboard";
}

function formatTime12Hour(hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!match) return hhmm || "—";
  let hour = Number(match[1]);
  const minute = match[2];
  const suffix = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;
  return `${hour}:${minute} ${suffix}`;
}

function applyWorkHoursLabels(hours = {}) {
  state.workHours = hours;
  const start = hours.work_start || "08:00";
  const end = hours.work_end || "17:00";
  const lateAfter = hours.late_after || "09:00";
  const earlyBefore = hours.early_leave_before || "16:00";

  const scheduleText = document.getElementById("scheduleText");
  const scheduleGrace = document.getElementById("scheduleGrace");
  const scheduleEarly = document.getElementById("scheduleEarly");
  const peopleSub = document.getElementById("peopleSub");
  const sLateLabel = document.getElementById("sLateLabel");
  const sEarlyLabel = document.getElementById("sEarlyLabel");

  if (scheduleText) scheduleText.textContent = `${formatTime12Hour(start)} – ${formatTime12Hour(end)}`;
  if (scheduleGrace) scheduleGrace.textContent = `Until ${formatTime12Hour(lateAfter)}`;
  if (scheduleEarly) scheduleEarly.textContent = `Before ${formatTime12Hour(earlyBefore)}`;
  if (peopleSub) peopleSub.textContent = `On time through ${formatTime12Hour(lateAfter)} · Early leave before ${formatTime12Hour(earlyBefore)}`;
  if (sLateLabel) sLateLabel.textContent = `Arrived after ${formatTime12Hour(lateAfter)}`;
  if (sEarlyLabel) sEarlyLabel.textContent = `Left before ${formatTime12Hour(earlyBefore)}`;
}

function fillSettingsForm(hours = {}) {
  document.getElementById("workStart").value = hours.work_start || "08:00";
  document.getElementById("lateAfter").value = hours.late_after || "09:00";
  document.getElementById("earlyLeaveBefore").value = hours.early_leave_before || "16:00";
  document.getElementById("workEnd").value = hours.work_end || "17:00";
}

function showView(view, { push = false } = {}) {
  if (!["dashboard", "attendance", "settings"].includes(view)) view = "dashboard";
  const pathname = pathForView(view);

  document.querySelectorAll("[data-view]").forEach((section) => {
    const active = section.dataset.view === view;
    section.hidden = !active;
    if (active) {
      section.classList.remove("is-entering");
      requestAnimationFrame(() => section.classList.add("is-entering"));
    }
  });

  document.querySelectorAll("[data-route]").forEach((link) => {
    const active = link.dataset.route === view;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  document.body.classList.remove("nav-open");
  document.getElementById("menuButton")?.setAttribute("aria-expanded", "false");
  document.title = `${titleForView(view)} · Workforce Attendance`;
  state.currentView = view;

  if (push && window.location.pathname !== pathname) history.pushState({ view }, "", pathname);
  window.scrollTo({ top: 0, behavior: "instant" });

  if (view === "dashboard") loadDashboard();
  else if (view === "attendance") loadAttendance();
  else loadSettings();
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-route]");
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  showView(link.dataset.route, { push: true });
});

window.addEventListener("popstate", () => showView(viewFromPath()));

function renderPeople(people) {
  if (!people.length) {
    peopleRows.innerHTML = `<tr><td class="empty" colspan="4">No attendance has been recorded today.</td></tr>`;
    return;
  }
  peopleRows.innerHTML = people.map((row) => `
    <tr>
      <td>${userCell(row)}</td>
      <td>${escapeHtml(row.check_in_time || "—")}</td>
      <td>${escapeHtml(row.check_out_time || "—")}</td>
      <td>${statusBadges(row)}</td>
    </tr>`).join("");
}

function formatHistoryDayLabel(ymd) {
  const text = String(ymd || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text || "—";
  const date = new Date(`${text}T12:00:00`);
  return date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function renderHistory(history = [], summary = {}) {
  const chartEl = document.getElementById("historyChart");
  const rowsElHistory = document.getElementById("historyRows");
  const historySub = document.getElementById("historySub");
  const hAvg = document.getElementById("hAvgPresent");
  const hLate = document.getElementById("hTotalLate");
  const hEarly = document.getElementById("hTotalEarly");

  if (hAvg) hAvg.textContent = summary.avg_present ?? 0;
  if (hLate) hLate.textContent = summary.total_late ?? 0;
  if (hEarly) hEarly.textContent = summary.total_left_early ?? 0;
  if (historySub) {
    historySub.textContent =
      summary.from && summary.to
        ? `${summary.from} → ${summary.to} · Africa/Lagos`
        : "Day-by-day transparency across the week";
  }

  if (!history.length) {
    if (chartEl) chartEl.innerHTML = "";
    if (rowsElHistory) {
      rowsElHistory.innerHTML = `<tr><td class="empty" colspan="6">No attendance history yet.</td></tr>`;
    }
    return;
  }

  const maxPresent = Math.max(...history.map((row) => Number(row.present) || 0), 1);

  if (chartEl) {
    chartEl.innerHTML = history
      .map((row) => {
        const present = Number(row.present) || 0;
        const late = Number(row.late) || 0;
        const early = Number(row.left_early) || 0;
        const presentPct = Math.max(8, Math.round((present / maxPresent) * 100));
        const latePct = present ? Math.round((late / present) * presentPct) : 0;
        const earlyPct = present ? Math.round((early / present) * presentPct) : 0;
        return `<div class="history-bar ${row.is_today ? "is-today" : ""}" title="${escapeHtml(row.date)}: ${present} present, ${late} late, ${early} left early">
          <div class="history-bar-stack" style="height:${presentPct}%">
            <span class="seg present" style="flex:${Math.max(present - late - early, 0)}"></span>
            <span class="seg late" style="flex:${late}"></span>
            <span class="seg early" style="flex:${early}"></span>
          </div>
          <strong>${present}</strong>
          <small>${escapeHtml(formatHistoryDayLabel(row.date))}</small>
        </div>`;
      })
      .join("");
  }

  if (rowsElHistory) {
    const newestFirst = [...history].reverse();
    rowsElHistory.innerHTML = newestFirst
      .map(
        (row) => `<tr class="${row.is_today ? "row-today" : ""}">
        <td>${escapeHtml(formatHistoryDayLabel(row.date))}${row.is_today ? " · Today" : ""}</td>
        <td>${escapeHtml(row.present)}</td>
        <td>${escapeHtml(row.late)}</td>
        <td>${escapeHtml(row.left_early)}</td>
        <td>${escapeHtml(row.completed)}</td>
        <td>${escapeHtml(row.still_in)}</td>
      </tr>`
      )
      .join("");
  }
}

async function loadDashboard({ force = false } = {}) {
  if (state.dashboardLoading || (state.dashboardLoaded && !force)) return;
  state.dashboardLoading = true;
  document.getElementById("dashRefreshBtn")?.classList.add("is-loading");

  try {
    const response = await fetch("/api/dashboard", { credentials: "same-origin" });
    if (!(await ensureAuth(response)) || !response.ok) return;
    const data = await response.json();
    const metrics = data.metrics || {};
    const hours = data.work_hours || {};

    document.getElementById("dashSub").textContent = `Today, ${data.date || "—"} · ${data.timezone || "Local time"}`;
    applyWorkHoursLabels(hours);

    const values = {
      mPresent: metrics.present, mStill: metrics.still_in, mDone: metrics.completed,
      mLate: metrics.late, mEarly: metrics.left_early, mAbsent: metrics.absent_estimate,
      sPresent: metrics.present, sLate: metrics.late, sEarly: metrics.left_early, sAbsent: metrics.absent_estimate,
    };
    Object.entries(values).forEach(([id, value]) => {
      const element = document.getElementById(id);
      if (element) element.textContent = value ?? 0;
    });
    renderPeople(data.people || []);
    renderHistory(data.history || [], data.history_summary || {});
    state.dashboardLoaded = true;
  } finally {
    state.dashboardLoading = false;
    document.getElementById("dashRefreshBtn")?.classList.remove("is-loading");
  }
}

function pageSize() { return Number(pageSizeEl.value) || PAGE_SIZES[0]; }
function totalPages() { return Math.max(1, Math.ceil(state.totalRows / pageSize())); }
function availablePageSizes(total) {
  const sizes = PAGE_SIZES.filter((size) => size <= total);
  return sizes.length ? sizes : [PAGE_SIZES[0]];
}

function syncPageSizeOptions() {
  const sizes = availablePageSizes(state.totalRows);
  const previous = pageSize();
  const next = sizes.includes(previous) ? previous : sizes[sizes.length - 1];
  pageSizeEl.innerHTML = sizes.map((size) => `<option value="${size}">${size}</option>`).join("");
  pageSizeEl.value = String(next);
  return next !== previous;
}

function queryParams({ forExport = false, day = null, fromDate = null, toDate = null } = {}) {
  const params = new URLSearchParams();
  if (fromDate && toDate) {
    params.set("from", `${fromDate} 00:00:00`);
    params.set("to", `${toDate} 23:59:59`);
  } else if (day) {
    params.set("from", `${day} 00:00:00`);
    params.set("to", `${day} 23:59:59`);
  } else {
    const from = document.getElementById("from").value;
    const to = document.getElementById("to").value;
    const pin = document.getElementById("pin").value.trim();
    const sn = document.getElementById("sn").value.trim();
    if (from) params.set("from", `${from} 00:00:00`);
    if (to) params.set("to", `${to} 23:59:59`);
    if (pin) params.set("pin", pin);
    if (sn) params.set("sn", sn);
  }
  params.set("limit", String(forExport ? 5000 : pageSize()));
  params.set("offset", String(forExport ? 0 : (state.currentPage - 1) * pageSize()));
  return params;
}

function todayDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addCalendarDays(ymd, delta) {
  const [year, month, day] = String(ymd).split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day + delta));
  return dt.toISOString().slice(0, 10);
}

function mondayOfWeek(ymd) {
  const [year, month, day] = String(ymd).split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  // Monday = 1 ... Sunday = 0 in getUTCDay, shift so Mon=0
  const weekday = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - weekday);
  return dt.toISOString().slice(0, 10);
}

function monthBounds(ym) {
  const [year, month] = String(ym).split("-").map(Number);
  const from = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const to = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

function selectedExportPeriod() {
  return document.querySelector('input[name="exportPeriod"]:checked')?.value || "daily";
}

function resolveExportRange() {
  const period = selectedExportPeriod();
  if (period === "weekly") {
    const anchor = document.getElementById("exportWeekDay").value;
    if (!anchor) return null;
    const from = mondayOfWeek(anchor);
    const to = addCalendarDays(from, 6);
    return { period, from, to, label: `Week ${from} → ${to}` };
  }
  if (period === "monthly") {
    const month = document.getElementById("exportMonth").value;
    if (!month) return null;
    const { from, to } = monthBounds(month);
    return { period, from, to, label: `Month ${month} (${from} → ${to})` };
  }
  const day = document.getElementById("exportDay").value;
  if (!day) return null;
  return { period: "daily", from: day, to: day, label: `Day ${day}` };
}

function syncExportPeriodFields() {
  const period = selectedExportPeriod();
  document.getElementById("exportDayWrap").hidden = period !== "daily";
  document.getElementById("exportWeekWrap").hidden = period !== "weekly";
  document.getElementById("exportMonthWrap").hidden = period !== "monthly";
  updateExportRangePreview();
}

function updateExportRangePreview() {
  const preview = document.getElementById("exportRangePreview");
  const range = resolveExportRange();
  preview.textContent = range ? `Will export: ${range.label}` : "Select a period to export.";
}

function setDayFilter(day) {
  document.getElementById("from").value = day;
  document.getElementById("to").value = day;
}

function applyTodayFilter() {
  setDayFilter(todayDate());
  state.currentPage = 1;
  updateAttendanceLabels();
  loadAttendance({ force: true });
}

function updateAttendanceLabels() {
  const today = todayDate();
  const from = document.getElementById("from").value;
  const to = document.getElementById("to").value;
  const attendanceSub = document.getElementById("attendanceSub");
  const recordsSub = document.getElementById("recordsSub");

  let label;
  if (from && to && from === to) {
    label = from === today ? "Today" : from;
  } else if (from || to) {
    label = `${from || "…"} → ${to || "…"}`;
  } else {
    label = "All days";
  }

  if (attendanceSub) {
    attendanceSub.textContent =
      label === "Today"
        ? "Showing today’s attendance. Use filters for other days."
        : `Showing ${label}. Clear returns to today.`;
  }
  if (recordsSub) recordsSub.textContent = `${label} · Africa/Lagos`;
}

function openExportModal() {
  const modal = document.getElementById("exportModal");
  const currentDay = document.getElementById("from").value || document.getElementById("to").value || todayDate();
  document.getElementById("exportDay").value = currentDay;
  document.getElementById("exportWeekDay").value = currentDay;
  document.getElementById("exportMonth").value = currentDay.slice(0, 7);
  const dailyRadio = document.querySelector('input[name="exportPeriod"][value="daily"]');
  if (dailyRadio) dailyRadio.checked = true;
  syncExportPeriodFields();
  modal.hidden = false;
  document.getElementById("exportDay").focus();
}

function closeExportModal() {
  document.getElementById("exportModal").hidden = true;
}

function confirmExport() {
  const range = resolveExportRange();
  if (!range) {
    const period = selectedExportPeriod();
    if (period === "weekly") document.getElementById("exportWeekDay").focus();
    else if (period === "monthly") document.getElementById("exportMonth").focus();
    else document.getElementById("exportDay").focus();
    return;
  }
  closeExportModal();
  window.location.href = `/api/attendance.csv?${queryParams({
    forExport: true,
    fromDate: range.from,
    toDate: range.to,
  })}`;
}

function updatePager() {
  const pages = totalPages();
  if (state.currentPage > pages) state.currentPage = pages;
  const from = state.totalRows === 0 ? 0 : (state.currentPage - 1) * pageSize() + 1;
  const to = Math.min(state.currentPage * pageSize(), state.totalRows);
  pageInfoEl.textContent = state.totalRows === 0 ? "0 records" : `${from}–${to} of ${state.totalRows}`;
  prevPageBtn.disabled = state.currentPage <= 1;
  nextPageBtn.disabled = state.currentPage >= pages || state.totalRows === 0;
}

function renderRows(rows) {
  if (!rows.length) {
    rowsEl.innerHTML = `<tr><td class="empty" colspan="6">No attendance records match these filters.</td></tr>`;
    return;
  }
  rowsEl.innerHTML = rows.map((row, index) => `
    <tr class="${index === 0 && state.currentPage === 1 ? "row-live" : ""}">
      <td>${userCell(row)}</td>
      <td>${escapeHtml(row.check_in_time || "—")}</td>
      <td>${escapeHtml(row.check_out_time || "—")}</td>
      <td>${escapeHtml(row.work_date)}</td>
      <td>${escapeHtml(row.punch_count)}</td>
      <td>${statusBadges(row)}</td>
    </tr>`).join("");
}

async function loadAttendance({ force = false } = {}) {
  if (state.attendanceLoading || (state.attendanceLoaded && !force)) return;
  state.attendanceLoading = true;
  document.getElementById("attendanceRefreshBtn")?.classList.add("is-loading");

  try {
    const response = await fetch(`/api/attendance?${queryParams()}`, { credentials: "same-origin" });
    if (!(await ensureAuth(response)) || !response.ok) return;
    const data = await response.json();
    state.latestPunchedAt = data.latest_punched_at || state.latestPunchedAt;
    state.totalRows = Number(data.total) || 0;
    if (syncPageSizeOptions()) {
      state.currentPage = 1;
      state.attendanceLoading = false;
      return loadAttendance({ force: true });
    }
    if (state.currentPage > totalPages()) {
      state.currentPage = totalPages();
      state.attendanceLoading = false;
      return loadAttendance({ force: true });
    }
    renderRows(data.rows || []);
    updatePager();
    updateAttendanceLabels();
    state.attendanceLoaded = true;
  } finally {
    state.attendanceLoading = false;
    document.getElementById("attendanceRefreshBtn")?.classList.remove("is-loading");
  }
}

function toInputDate(value) {
  if (!value) return "";
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function syncUsers() {
  const sn = document.getElementById("sn").value.trim() || "SQE8234700094";
  const response = await fetch(`/api/sync-users?sn=${encodeURIComponent(sn)}`, { method: "POST", credentials: "same-origin" });
  if (!(await ensureAuth(response)) || !response.ok) return;
  setTimeout(() => loadAttendance({ force: true }), 2500);
}

async function loadSettings({ force = false } = {}) {
  if (state.settingsLoading || (state.settingsLoaded && !force)) return;
  state.settingsLoading = true;
  const statusEl = document.getElementById("settingsStatus");
  if (statusEl && !state.settingsLoaded) statusEl.textContent = "Loading…";

  try {
    const response = await fetch("/api/settings", { credentials: "same-origin" });
    if (!(await ensureAuth(response)) || !response.ok) {
      if (statusEl) statusEl.textContent = "Could not load settings.";
      return;
    }
    const data = await response.json();
    const hours = data.work_hours || {};
    fillSettingsForm(hours);
    applyWorkHoursLabels(hours);
    state.settingsLoaded = true;
    if (statusEl) {
      statusEl.textContent = data.updated_at
        ? `Last saved ${new Date(data.updated_at).toLocaleString()}`
        : "Using default working hours.";
    }
  } finally {
    state.settingsLoading = false;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const statusEl = document.getElementById("settingsStatus");
  const saveBtn = document.getElementById("settingsSaveBtn");
  const work_hours = {
    work_start: document.getElementById("workStart").value,
    late_after: document.getElementById("lateAfter").value,
    early_leave_before: document.getElementById("earlyLeaveBefore").value,
    work_end: document.getElementById("workEnd").value,
  };

  saveBtn?.classList.add("is-loading");
  if (statusEl) statusEl.textContent = "Saving…";

  try {
    const response = await fetch("/api/settings", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ work_hours }),
    });
    if (!(await ensureAuth(response))) return;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (statusEl) statusEl.textContent = data.error || "Could not save settings.";
      return;
    }
    fillSettingsForm(data.work_hours || work_hours);
    applyWorkHoursLabels(data.work_hours || work_hours);
    state.settingsLoaded = true;
    state.dashboardLoaded = false;
    state.attendanceLoaded = false;
    if (statusEl) {
      statusEl.textContent = data.updated_at
        ? `Saved ${new Date(data.updated_at).toLocaleString()}`
        : "Working day saved.";
    }
    loadDashboard({ force: true });
    if (state.currentView === "attendance" || state.attendanceLoaded) {
      loadAttendance({ force: true });
    }
  } finally {
    saveBtn?.classList.remove("is-loading");
  }
}

function clearFilters() {
  document.getElementById("pin").value = "";
  document.getElementById("sn").value = "";
  applyTodayFilter();
}

filtersForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.currentPage = 1;
  updateAttendanceLabels();
  loadAttendance({ force: true });
});
pageSizeEl.addEventListener("change", () => { state.currentPage = 1; loadAttendance({ force: true }); });
prevPageBtn.addEventListener("click", () => { if (state.currentPage > 1) { state.currentPage -= 1; loadAttendance({ force: true }); } });
nextPageBtn.addEventListener("click", () => { if (state.currentPage < totalPages()) { state.currentPage += 1; loadAttendance({ force: true }); } });
document.getElementById("dashRefreshBtn").addEventListener("click", () => loadDashboard({ force: true }));
document.getElementById("attendanceRefreshBtn").addEventListener("click", () => loadAttendance({ force: true }));
document.getElementById("syncUsersBtn").addEventListener("click", syncUsers);
document.getElementById("exportBtn").addEventListener("click", openExportModal);
document.getElementById("exportCancelBtn")?.addEventListener("click", closeExportModal);
document.getElementById("exportConfirmBtn")?.addEventListener("click", confirmExport);
document.getElementById("exportModal")?.addEventListener("click", (event) => {
  if (event.target.id === "exportModal") closeExportModal();
});
document.querySelectorAll('input[name="exportPeriod"]').forEach((input) => {
  input.addEventListener("change", syncExportPeriodFields);
});
["exportDay", "exportWeekDay", "exportMonth"].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", updateExportRangePreview);
  document.getElementById(id)?.addEventListener("input", updateExportRangePreview);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.getElementById("exportModal")?.hidden) closeExportModal();
});
document.getElementById("todayBtn")?.addEventListener("click", applyTodayFilter);
document.getElementById("clearBtn").addEventListener("click", clearFilters);
document.getElementById("settingsForm")?.addEventListener("submit", saveSettings);
document.getElementById("toggleFilters")?.addEventListener("click", (event) => {
  const panel = event.currentTarget.closest(".filter-panel");
  const collapsed = panel.classList.toggle("collapsed");
  event.currentTarget.setAttribute("aria-expanded", String(!collapsed));
  event.currentTarget.textContent = collapsed ? "⌄" : "⌃";
});

function connectLive() {
  state.eventSource?.close();
  state.eventSource = new EventSource("/api/events", { withCredentials: true });
  state.eventSource.addEventListener("connected", () => {
    loadDashboard({ force: true });
    if (state.attendanceLoaded) loadAttendance({ force: true });
  });
  state.eventSource.addEventListener("attendance", () => {
    loadDashboard({ force: true });
    if (state.attendanceLoaded) loadAttendance({ force: true });
  });
  state.eventSource.addEventListener("users", () => {
    if (state.attendanceLoaded) loadAttendance({ force: true });
  });
  state.eventSource.addEventListener("settings", (event) => {
    try {
      const payload = JSON.parse(event.data || "{}");
      if (payload.work_hours) {
        applyWorkHoursLabels(payload.work_hours);
        if (state.currentView === "settings" || state.settingsLoaded) fillSettingsForm(payload.work_hours);
      }
    } catch {
      /* ignore malformed live payload */
    }
    state.dashboardLoaded = false;
    state.attendanceLoaded = false;
    if (state.currentView === "dashboard") loadDashboard({ force: true });
    if (state.currentView === "attendance") loadAttendance({ force: true });
    if (state.currentView === "settings") loadSettings({ force: true });
  });
  state.eventSource.onerror = () => {
    state.eventSource.close();
    setTimeout(connectLive, 2500);
  };
}

setDayFilter(todayDate());
updateAttendanceLabels();
const initialView = viewFromPath();
showView(initialView);
// Preload other views after first paint so navigation feels instant.
setTimeout(() => {
  if (initialView !== "dashboard") loadDashboard();
  if (initialView !== "attendance") loadAttendance();
  if (initialView !== "settings") loadSettings();
}, 350);
connectLive();
