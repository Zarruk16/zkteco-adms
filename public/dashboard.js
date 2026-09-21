const peopleRows = document.getElementById("peopleRows");

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

function statusBadges(row) {
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

function renderPeople(people) {
  if (!people.length) {
    peopleRows.innerHTML = `<tr><td class="empty" colspan="4">No attendance has been recorded today.</td></tr>`;
    return;
  }

  peopleRows.innerHTML = people.map((row) => `
    <tr>
      <td data-label="User">
        <div class="user-cell">
          <span class="user-initial">${escapeHtml(initials(row.user_name, row.user_pin))}</span>
          <span class="user-meta"><strong>${escapeHtml(row.user_name || "Unnamed user")}</strong><small>ID ${escapeHtml(row.user_pin)}</small></span>
        </div>
      </td>
      <td data-label="Check-in">${escapeHtml(row.check_in_time || "—")}</td>
      <td data-label="Check-out">${escapeHtml(row.check_out_time || "—")}</td>
      <td data-label="Status">${statusBadges(row)}</td>
    </tr>`).join("");
}

async function loadDashboard() {
  const response = await fetch("/api/dashboard", { credentials: "same-origin" });
  if (!(await ensureAuth(response)) || !response.ok) return;
  const data = await response.json();
  const metrics = data.metrics || {};
  const hours = data.work_hours || {};

  document.getElementById("dashSub").textContent = `Today, ${data.date || "—"} · ${data.timezone || "Local time"}`;
  document.getElementById("scheduleText").textContent = `${hours.work_start || "08:00"} – ${hours.work_end || "17:00"}`;
  document.getElementById("peopleSub").textContent = `On time through ${hours.late_after || "09:00"} · Early leave before ${hours.early_leave_before || "16:00"}`;

  const values = {
    mPresent: metrics.present,
    mStill: metrics.still_in,
    mDone: metrics.completed,
    mLate: metrics.late,
    mEarly: metrics.left_early,
    mAbsent: metrics.absent_estimate,
    sPresent: metrics.present,
    sLate: metrics.late,
    sEarly: metrics.left_early,
    sAbsent: metrics.absent_estimate,
  };
  Object.entries(values).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value ?? 0;
  });

  renderPeople(data.people || []);
}

function connectLive() {
  const source = new EventSource("/api/events", { withCredentials: true });
  ["attendance", "users", "connected"].forEach((event) => source.addEventListener(event, loadDashboard));
  source.onerror = () => {
    source.close();
    setTimeout(connectLive, 2500);
  };
}

document.getElementById("refreshBtn")?.addEventListener("click", loadDashboard);
loadDashboard();
connectLive();
