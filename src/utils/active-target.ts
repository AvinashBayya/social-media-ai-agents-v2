// Global Target Acquisition State Manager
// Synchronizes active search target across top navbar and all intelligence routes

export function getActiveTarget(): string {
  if (typeof window === "undefined") return "google.com";
  const urlParams = new URLSearchParams(window.location.search);
  const q = urlParams.get("q");
  if (q && q.trim()) {
    localStorage.setItem("sentinel_active_target", q.trim());
    return q.trim();
  }
  return localStorage.getItem("sentinel_active_target") || "google.com";
}

export function setActiveTarget(query: string) {
  if (typeof window === "undefined") return;
  const trimmed = query.trim();
  if (!trimmed) return;
  
  localStorage.setItem("sentinel_active_target", trimmed);

  const url = new URL(window.location.href);
  url.searchParams.set("q", trimmed);
  window.history.pushState({}, "", url.toString());

  // Dispatch custom event for reactive UI updates
  window.dispatchEvent(new CustomEvent("sentinel_target_changed", { detail: trimmed }));
}
