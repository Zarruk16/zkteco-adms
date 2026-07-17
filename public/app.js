const rowsEl = document.getElementById("rows");
const formEl = document.getElementById("filters");
const pageSizeEl = document.getElementById("pageSize");
const pageInfoEl = document.getElementById("pageInfo");
const prevPageBtn = document.getElementById("prevPage");
const nextPageBtn = document.getElementById("nextPage");

const PAGE_SIZES = [10, 15, 20, 25, 50];

let latestPunchedAt = null;
let eventSource = null;
let currentPage = 1;
let totalRows = 0;

function pageSize() {
  return Number(pageSizeEl.value) || PAGE_SIZES[0];
}

function totalPages() {
  return Math.max(1, Math.ceil(totalRows / pageSize()));
}

/** Only offer sizes the table can fill (e.g. no 50 if fewer than 50 rows). */
function availablePageSizes(total) {
  const sizes = PAGE_SIZES.filter((size) => size <= total);
  return sizes.length ? sizes : [PAGE_SIZES[0]];
}

function syncPageSizeOptions() {
  const sizes = availablePageSizes(totalRows);
  const previous = pageSize();
  const next = sizes.includes(previous) ? previous : sizes[sizes.length - 1];

  pageSizeEl.innerHTML = sizes
    .map((size) => `<option value="${size}">${size}</option>`)
    .join("");
  pageSizeEl.value = String(next);

  return next !== previous;
}

function queryParams({ forExport = false } = {}) {
  const from = document.getElementById("from").value;
  const to = document.getElementById("to").value;
  const pin = document.getElementById("pin").value.trim();
  const sn = document.getElementById("sn").value.trim();
  const params = new URLSearchParams();
  if (from) params.set("from", `${from} 00:00:00`);
  if (to) params.set("to", `${to} 23:59:59`);
  if (pin) params.set("pin", pin);
  if (sn) params.set("sn", sn);

  if (forExport) {
    params.set("limit", "5000");
    params.set("offset", "0");
  } else {
    const size = pageSize();
    params.set("limit", String(size));
    params.set("offset", String((currentPage - 1) * size));
  }
  return params;
}

function updatePager() {
  const pages = totalPages();
  if (currentPage > pages) currentPage = pages;

  const size = pageSize();
  const from = totalRows === 0 ? 0 : (currentPage - 1) * size + 1;
  const to = Math.min(currentPage * size, totalRows);

  pageInfoEl.textContent =
    totalRows === 0
      ? "0 records"
      : `${from}–${to} of ${totalRows} · Page ${currentPage} of ${pages}`;

  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= pages || totalRows === 0;
}

function renderRows(rows) {
  if (!rows.length) {
    rowsEl.innerHTML = `<tr><td class="empty" colspan="7">No daily records match these filters. Click <strong>Latest day</strong> or <strong>Clear filters</strong>.</td></tr>`;
    return;
  }

  rowsEl.innerHTML = rows
    .map(
      (row, index) => `
      <tr class="${index === 0 && currentPage === 1 ? "row-live" : ""}">
        <td>${escapeHtml(row.work_date)}</td>
        <td>${escapeHtml(row.user_pin)}</td>
        <td>${escapeHtml(row.user_name || "—")}</td>
        <td>${escapeHtml(row.check_in_time || "—")}</td>
        <td>${escapeHtml(row.check_out_time || "—")}</td>
        <td>${escapeHtml(row.punch_count)}</td>
        <td><span class="badge ${row.punch_count > 1 ? "badge-ok" : "badge-in"}">${escapeHtml(
          row.status_label || "—"
        )}</span></td>
      </tr>`
    )
    .join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toInputDate(value) {
  if (!value) return "";
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function applyLatestDayFilter() {
  if (!latestPunchedAt) return;
  const latestDate = toInputDate(latestPunchedAt);
  document.getElementById("from").value = latestDate;
  document.getElementById("to").value = latestDate;
  currentPage = 1;
  loadAttendance();
}

function clearFilters() {
  document.getElementById("from").value = "";
  document.getElementById("to").value = "";
  document.getElementById("pin").value = "";
  document.getElementById("sn").value = "";
  currentPage = 1;
  loadAttendance();
}

async function syncUsers() {
  const sn = document.getElementById("sn").value.trim() || "SQE8234700094";
  const res = await fetch(`/api/sync-users?sn=${encodeURIComponent(sn)}`, {
    method: "POST",
  });
  if (!res.ok) return;
  setTimeout(() => loadAttendance(), 3000);
}

async function loadAttendance() {
  const params = queryParams();
  const res = await fetch(`/api/attendance?${params.toString()}`);
  if (!res.ok) return;
  const data = await res.json();
  latestPunchedAt = data.latest_punched_at || latestPunchedAt;
  totalRows = Number(data.total) || 0;

  if (syncPageSizeOptions()) {
    currentPage = 1;
    return loadAttendance();
  }

  const pages = totalPages();
  if (currentPage > pages) {
    currentPage = pages;
    return loadAttendance();
  }

  renderRows(data.rows || []);
  updatePager();
}

function exportCsv() {
  const params = queryParams({ forExport: true });
  window.location.href = `/api/attendance.csv?${params.toString()}`;
}

function connectLive() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  eventSource = new EventSource("/api/events");

  eventSource.addEventListener("connected", () => {
    loadAttendance();
  });

  eventSource.addEventListener("attendance", () => {
    loadAttendance();
  });

  eventSource.addEventListener("users", () => {
    loadAttendance();
  });

  eventSource.onerror = () => {
    eventSource.close();
    eventSource = null;
    setTimeout(connectLive, 2000);
  };
}

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  currentPage = 1;
  loadAttendance();
});

pageSizeEl.addEventListener("change", () => {
  currentPage = 1;
  loadAttendance();
});

prevPageBtn.addEventListener("click", () => {
  if (currentPage <= 1) return;
  currentPage -= 1;
  loadAttendance();
});

nextPageBtn.addEventListener("click", () => {
  if (currentPage >= totalPages()) return;
  currentPage += 1;
  loadAttendance();
});

document.getElementById("refreshBtn").addEventListener("click", () => loadAttendance());
document.getElementById("exportBtn").addEventListener("click", exportCsv);
document.getElementById("latestBtn").addEventListener("click", applyLatestDayFilter);
document.getElementById("clearBtn").addEventListener("click", clearFilters);
document.getElementById("syncUsersBtn").addEventListener("click", syncUsers);

loadAttendance();
connectLive();
