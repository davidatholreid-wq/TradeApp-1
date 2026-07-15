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
