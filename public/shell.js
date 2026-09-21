const MANAGER_CACHE_KEY = "wa_manager_username";
const menuButton = document.getElementById("menuButton");
const overlay = document.getElementById("navOverlay");

function setMenuOpen(open) {
  document.body.classList.toggle("nav-open", open);
  menuButton?.setAttribute("aria-expanded", String(open));
}

function applyManagerIdentity(username) {
  if (!username) return;
  const display = String(username).trim();
  if (!display) return;

  document.querySelectorAll("[data-manager-name]").forEach((element) => {
    element.textContent = display;
  });

  const initial = display.slice(0, 1).toUpperCase();
  document.querySelectorAll("[data-manager-avatar]").forEach((element) => {
    element.textContent = initial;
  });
}

function clearManagerIdentity() {
  sessionStorage.removeItem(MANAGER_CACHE_KEY);
}

// Apply cached identity immediately so page switches don't flash "Manager".
applyManagerIdentity(sessionStorage.getItem(MANAGER_CACHE_KEY));

menuButton?.addEventListener("click", () => setMenuOpen(!document.body.classList.contains("nav-open")));
overlay?.addEventListener("click", () => setMenuOpen(false));

document.querySelectorAll("[data-logout]").forEach((button) => {
  button.addEventListener("click", async () => {
    clearManagerIdentity();
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    window.location.href = "/login";
  });
});

async function loadManagerIdentity() {
  const response = await fetch("/api/me", { credentials: "same-origin" });
  if (response.status === 401) {
    clearManagerIdentity();
    window.location.href = "/login";
    return;
  }
  if (!response.ok) return;

  const data = await response.json();
  const username = data.user?.username;
  if (!username) return;

  sessionStorage.setItem(MANAGER_CACHE_KEY, username);
  applyManagerIdentity(username);
}

loadManagerIdentity();
