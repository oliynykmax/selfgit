try {
  if (localStorage.getItem("theme") === "dark")
    document.documentElement.classList.add("dark");
} catch {
  // Storage is blocked, so the page keeps the system theme.
}
