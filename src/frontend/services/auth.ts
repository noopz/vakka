// ---------------------------------------------------------------------------
// Device credentials (localStorage — persistent across sessions)
// ---------------------------------------------------------------------------

export function getDeviceId(): string | null {
  return localStorage.getItem("vakka-device-id");
}

export function getDeviceSecret(): string | null {
  return localStorage.getItem("vakka-device-secret");
}

export function setDeviceCredentials(id: string, secret: string): void {
  localStorage.setItem("vakka-device-id", id);
  localStorage.setItem("vakka-device-secret", secret);
}

export function clearDeviceCredentials(): void {
  localStorage.removeItem("vakka-device-id");
  localStorage.removeItem("vakka-device-secret");
}

// ---------------------------------------------------------------------------
// Auth header for API requests
// ---------------------------------------------------------------------------

export function getAuthHeader(): string | null {
  const id = getDeviceId();
  const secret = getDeviceSecret();
  if (id && secret) return `Device ${id}:${secret}`;

  // Legacy fallback
  const token = getToken();
  if (token) return `Bearer ${token}`;

  return null;
}

export function hasAuth(): boolean {
  return !!(getDeviceId() && getDeviceSecret()) || !!getToken();
}

// ---------------------------------------------------------------------------
// Legacy bearer token (sessionStorage — fallback)
// ---------------------------------------------------------------------------

export function getToken(): string | null {
  return sessionStorage.getItem("vakka-token");
}

export function setToken(token: string): void {
  sessionStorage.setItem("vakka-token", token);
}

export function clearToken(): void {
  sessionStorage.removeItem("vakka-token");
}

export function logout(): void {
  clearDeviceCredentials();
  clearToken();
}

// ---------------------------------------------------------------------------
// Pairing-mode (auth-required API)
// ---------------------------------------------------------------------------

async function authedJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = getAuthHeader();
  if (auth) headers["Authorization"] = auth;
  const res = await fetch(path, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export function fetchPairingMode(): Promise<{ pairingMode: boolean }> {
  return authedJson<{ pairingMode: boolean }>("/api/auth/pairing-mode");
}

export function setPairingMode(enabled: boolean): Promise<{ pairingMode: boolean }> {
  return authedJson<{ pairingMode: boolean }>("/api/auth/pairing-mode", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}
