import { storage } from "@/src/utils/storage";

const BASE_URL = process.env.EXPO_PUBLIC_BACKEND_URL;
export const TOKEN_KEY = "app.auth.token";

export async function apiFetch(path: string, options: RequestInit = {}) {
  const token = await storage.secureGet<string>(TOKEN_KEY, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data?.detail || data?.message || `HTTP ${res.status}`);
    (err as any).status = res.status;
    (err as any).data = data;
    throw err;
  }
  return data;
}


/**
 * Build a fully-qualified URL for a backend asset (PDF, image, etc.).
 * Used when opening a file in a new tab / hitting a Response endpoint
 * that isn't going through the JSON `apiFetch` helper.
 *
 * Example: `buildAssetUrl("/api/admin/dealerships/xyz/statement.pdf")`
 * → `"https://api.example.com/api/admin/dealerships/xyz/statement.pdf"`
 */
export function buildAssetUrl(path: string): string {
  const base = (BASE_URL || "").replace(/\/$/, "");
  if (!path) return base;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}


/**
 * Fetch an authenticated PDF from the backend and open it in the user's
 * browser (Web) or via `Linking.openURL(dataUrl)` (native). Handles the
 * Bearer-token auth that `window.open()` can't attach.
 */
export async function openAuthedPdf(path: string, filename?: string): Promise<void> {
  const token = await storage.secureGet<string>(TOKEN_KEY, "");
  const res = await fetch(buildAssetUrl(path), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch PDF (HTTP ${res.status})`);
  }
  const blob = await res.blob();
  if (typeof window !== "undefined" && (window as any).URL?.createObjectURL) {
    const url = (window as any).URL.createObjectURL(blob);
    const win = (window as any).open?.(url, "_blank");
    if (!win) {
      // Popup blocked — fall back to a download link.
      const a = (window as any).document.createElement("a");
      a.href = url;
      a.download = filename || "document.pdf";
      a.click();
    }
    // Release the object URL after a delay so the tab has time to load.
    setTimeout(() => { try { (window as any).URL.revokeObjectURL(url); } catch {} }, 60_000);
  }
}
