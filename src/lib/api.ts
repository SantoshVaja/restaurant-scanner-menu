const rawApiBase = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL || '';
export const API_BASE_URL = rawApiBase.replace(/\/+$/, '');

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${normalized}`;
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), init);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseJsonSafe<T = Record<string, any>>(resp: Response): Promise<T> {
  const raw = await resp.text();
  if (!raw || !raw.trim()) {
    if (!resp.ok) {
      throw new Error(
        `Backend API returned HTTP ${resp.status} with an empty response. Ensure the Node.js server (server.ts) is running and serving /api/* routes.`
      );
    }
    return {} as T;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `API endpoint returned non-JSON content (HTTP ${resp.status}). Static-only hosting (such as Cloudflare Workers Assets without a backend) cannot handle /api/* requests.`
    );
  }
}
