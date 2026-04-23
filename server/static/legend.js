const toggle = document.getElementById("themeToggle");

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  toggle.textContent = theme === "dark" ? "Light mode" : "Dark mode";
  localStorage.setItem("prosody-theme", theme);
}

const saved = localStorage.getItem("prosody-theme");
const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
applyTheme(saved || (prefersDark ? "dark" : "light"));

toggle.addEventListener("click", () => {
  const next = document.body.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
});
