const rowsEl = document.getElementById("rows");
const formEl = document.getElementById("filters");
const pageSizeEl = document.getElementById("pageSize");
const pageInfoEl = document.getElementById("pageInfo");
const prevPageBtn = document.getElementById("prevPage");
const nextPageBtn = document.getElementById("nextPage");
const PAGE_SIZES = [10, 15, 20, 25, 50];

let latestPunchedAt = null;
let currentPage = 1;
let totalRows = 0;
let eventSource = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function initials(name, pin) {
  const letters = String(name || "").replace(/[^a-zA-Z ]/g, "").trim().split(/\s+/).map((part) => part[0]).join("").slice(0, 2);
  return (letters || String(pin || "U").slice(-2)).toUpperCase();
}

async function ensureAuth(response) {
  if (response.status === 401) {
    window.location.href = "/login";
    return false;
  }
  return true;
}

function pageSize() { return Number(pageSizeEl.value) || PAGE_SIZES[0]; }
function totalPages() { return Math.max(1, Math.ceil(totalRows / pageSize())); }

function availablePageSizes(total) {
  const sizes = PAGE_SIZES.filter((size) => size <= total);
  return sizes.length ? sizes : [PAGE_SIZES[0]];
}

function syncPageSizeOptions() {
  const sizes = availablePageSizes(totalRows);
  const previous = pageSize();
  const next = sizes.includes(previous) ? previous : sizes[sizes.length - 1];
  pageSizeEl.innerHTML = sizes.map((size) => `<option value="${size}">${size}</option>`).join("");
  pageSizeEl.value = String(next);
  return next !== previous;
}

function queryParams({ forExport = false } = {}) {
  const params = new URLSearchParams();
  const from = document.getElementById("from").value;
  const to = document.getElementById("to").value;
  const pin = document.getElementById("pin").value.trim();
  const sn = document.getElementById("sn").value.trim();
  if (from) params.set("from", `${from} 00:00:00`);
  if (to) params.set("to", `${to} 23:59:59`);
  if (pin) params.set("pin", pin);
  if (sn) params.set("sn", sn);
  params.set("limit", String(forExport ? 5000 : pageSize()));
  params.set("offset", String(forExport ? 0 : (currentPage - 1) * pageSize()));
  return params;
}

function updatePager() {
  const pages = totalPages();
  if (currentPage > pages) currentPage = pages;
  const from = totalRows === 0 ? 0 : (currentPage - 1) * pageSize() + 1;
  const to = Math.min(currentPage * pageSize(), totalRows);
  pageInfoEl.textContent = totalRows === 0 ? "0 records" : `${from}–${to} of ${totalRows}`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= pages || totalRows === 0;
}

function statusCell(row) {
  const badges = [];
  if (row.late) badges.push(`<span class="badge badge-late">Late</span>`);
  if (row.left_early) badges.push(`<span class="badge badge-early">Left early</span>`);
  if (!badges.length) {
    badges.push(row.punch_count > 1
      ? `<span class="badge badge-ok">Complete</span>`
      : `<span class="badge badge-in">Checked in</span>`);
  }
  return `<div class="badge-row">${badges.join("")}</div>`;
}

function renderRows(rows) {
  if (!rows.length) {
    rowsEl.innerHTML = `<tr><td class="empty" colspan="6">No attendance records match these filters.</td></tr>`;
    return;
  }

  rowsEl.innerHTML = rows.map((row, index) => `
    <tr class="${index === 0 && currentPage === 1 ? "row-live" : ""}">
      <td data-label="User">
        <div class="user-cell">
          <span class="user-initial">${escapeHtml(initials(row.user_name, row.user_pin))}</span>
          <span class="user-meta"><strong>${escapeHtml(row.user_name || "Unnamed user")}</strong><small>ID ${escapeHtml(row.user_pin)}</small></span>
        </div>
      </td>
      <td data-label="Clock in">${escapeHtml(row.check_in_time || "—")}</td>
      <td data-label="Clock out">${escapeHtml(row.check_out_time || "—")}</td>
      <td data-label="Date">${escapeHtml(row.work_date)}</td>
      <td data-label="Punches">${escapeHtml(row.punch_count)}</td>
      <td data-label="Status">${statusCell(row)}</td>
    </tr>`).join("");
}

function toInputDate(value) {
  if (!value) return "";
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function loadAttendance() {
  const response = await fetch(`/api/attendance?${queryParams()}`, { credentials: "same-origin" });
  if (!(await ensureAuth(response)) || !response.ok) return;
  const data = await response.json();
  latestPunchedAt = data.latest_punched_at || latestPunchedAt;
  totalRows = Number(data.total) || 0;
  if (syncPageSizeOptions()) { currentPage = 1; return loadAttendance(); }
  if (currentPage > totalPages()) { currentPage = totalPages(); return loadAttendance(); }
  renderRows(data.rows || []);
  updatePager();
}

async function syncUsers() {
  const sn = document.getElementById("sn").value.trim() || "SQE8234700094";
  const response = await fetch(`/api/sync-users?sn=${encodeURIComponent(sn)}`, { method: "POST", credentials: "same-origin" });
  if (!(await ensureAuth(response)) || !response.ok) return;
  setTimeout(loadAttendance, 3000);
}

function applyLatestDayFilter() {
  if (!latestPunchedAt) return;
  const day = toInputDate(latestPunchedAt);
  document.getElementById("from").value = day;
  document.getElementById("to").value = day;
  currentPage = 1;
  loadAttendance();
}

function clearFilters() {
  ["from", "to", "pin", "sn"].forEach((id) => { document.getElementById(id).value = ""; });
  currentPage = 1;
  loadAttendance();
}

function connectLive() {
  eventSource?.close();
  eventSource = new EventSource("/api/events", { withCredentials: true });
  ["connected", "attendance", "users"].forEach((event) => eventSource.addEventListener(event, loadAttendance));
  eventSource.onerror = () => { eventSource.close(); setTimeout(connectLive, 2500); };
}

formEl.addEventListener("submit", (event) => { event.preventDefault(); currentPage = 1; loadAttendance(); });
pageSizeEl.addEventListener("change", () => { currentPage = 1; loadAttendance(); });
prevPageBtn.addEventListener("click", () => { if (currentPage > 1) { currentPage -= 1; loadAttendance(); } });
nextPageBtn.addEventListener("click", () => { if (currentPage < totalPages()) { currentPage += 1; loadAttendance(); } });
document.getElementById("refreshBtn").addEventListener("click", loadAttendance);
document.getElementById("exportBtn").addEventListener("click", () => { window.location.href = `/api/attendance.csv?${queryParams({ forExport: true })}`; });
document.getElementById("latestBtn").addEventListener("click", applyLatestDayFilter);
document.getElementById("clearBtn").addEventListener("click", clearFilters);
document.getElementById("syncUsersBtn").addEventListener("click", syncUsers);
document.getElementById("toggleFilters")?.addEventListener("click", (event) => {
  const panel = event.currentTarget.closest(".filter-panel");
  const collapsed = panel.classList.toggle("collapsed");
  event.currentTarget.setAttribute("aria-expanded", String(!collapsed));
  event.currentTarget.textContent = collapsed ? "⌄" : "⌃";
});

loadAttendance();
connectLive();
