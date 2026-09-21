const form = document.getElementById("loginForm");
const errorEl = document.getElementById("loginError");
const btn = document.getElementById("loginBtn");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.hidden = true;
  btn.disabled = true;
  btn.textContent = "Signing in…";

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        username: document.getElementById("username").value.trim(),
        password: document.getElementById("password").value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errorEl.textContent = data.error || "Invalid username or password";
      errorEl.hidden = false;
      return;
    }
    const username = data.user?.username || document.getElementById("username").value.trim();
    if (username) sessionStorage.setItem("wa_manager_username", username);
    window.location.href = "/";
  } catch {
    errorEl.textContent = "Could not reach the server";
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});
