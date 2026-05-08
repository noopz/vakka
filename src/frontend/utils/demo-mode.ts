// Demo mode — redacts identifying strings for screenshots.
//
// Activate via `?demo=1` in the URL. Persists to localStorage so it
// survives SPA navigation. `?demo=0` clears it. `?demo=1&blur=1` adds
// `.demo-blur-active` to <body>, blurring message bodies via CSS.

const STORAGE_KEY = "vakka_demo";
const BLUR_KEY = "vakka_demo_blur";

const CODENAMES = [
  "falcon", "kestrel", "otter", "willow", "slate",
  "ember", "glacier", "cedar", "haven", "lynx",
  "cobalt", "aspen", "dune", "heron", "mira",
  "nova", "petal", "quill", "ridge", "solace",
];

const slugMap = new Map<string, string>([
  ["vekka", "falcon"],
  ["vakka", "falcon"],
]);
let anonCounter = 0;

function fnv32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function readParam(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

function readStorage(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeStorage(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    /* private mode — ignore */
  }
}

export function isDemoMode(): boolean {
  const p = readParam("demo");
  if (p === "1") {
    writeStorage(STORAGE_KEY, true);
    return true;
  }
  if (p === "0") {
    writeStorage(STORAGE_KEY, false);
    writeStorage(BLUR_KEY, false);
    return false;
  }
  return readStorage(STORAGE_KEY);
}

export function isBlurMode(): boolean {
  const p = readParam("demo_blur");
  if (p === "1") {
    writeStorage(STORAGE_KEY, true);
    writeStorage(BLUR_KEY, true);
    return true;
  }
  if (p === "0") {
    writeStorage(BLUR_KEY, false);
    return false;
  }
  return readStorage(BLUR_KEY);
}

export function redactSlug(slug: string): string {
  if (!slug) return slug;
  const key = slug.toLowerCase();
  const cached = slugMap.get(key);
  if (cached !== undefined) return cached;

  const h = fnv32(key);
  const taken = new Set(slugMap.values());
  let chosen = `anon-${anonCounter++}`;
  for (let i = 0; i < CODENAMES.length; i++) {
    const candidate = CODENAMES[(h + i) % CODENAMES.length];
    if (!taken.has(candidate)) {
      chosen = candidate;
      break;
    }
  }
  slugMap.set(key, chosen);
  return chosen;
}

export function redactPath(path: string): string {
  if (!path) return path;
  let out = path.replace(
    /^(\/(?:Users|home)\/)[^/]+(\/.*)?$/,
    (_, prefix, rest) => `${prefix}demo${rest ?? ""}`,
  );
  out = out.replace(/\/([^/]+)\/?$/, (_, last) => `/${redactSlug(last)}`);
  return out;
}

export function redactText(text: string): string {
  if (!text) return text;
  let h = fnv32(text);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h = Math.imul(h ^ c, 16777619) >>> 0;
    if (c >= 97 && c <= 122) out += String.fromCharCode(97 + (h % 26));
    else if (c >= 65 && c <= 90) out += String.fromCharCode(65 + (h % 26));
    else if (c >= 48 && c <= 57) out += String.fromCharCode(48 + (h % 10));
    else out += text[i];
  }
  return out;
}

export function redactId(id: string): string {
  if (!id) return id;
  const h1 = fnv32(id).toString(16).toUpperCase().padStart(8, "0");
  const h2 = fnv32(id + "\x00salt").toString(16).toUpperCase().padStart(8, "0");
  return `0x${h1.slice(0, 4)}…${h2.slice(-4)}`;
}

export function applyBodyClasses(): void {
  if (typeof document === "undefined") return;
  if (isDemoMode()) document.body.classList.add("demo-mode-active");
  if (isBlurMode()) document.body.classList.add("demo-blur-active");
}
