// Project-level liveness via process introspection.
//
// Background — see Phase 0.5 v2 spike (scripts/spike-libproc.ts):
// The Claude Code SDK uses an open-write-close pattern per record, so the
// "is any process holding this jsonl FD open right now" approach (abtop's
// trick) returns nothing on macOS. What works is reading each candidate
// process's *current working directory* and matching against project paths.
// CC writes one jsonl at a time, so the freshest jsonl in an active project
// dir is the live writer; older jsonls in the same project are idle.
//
// macOS:  Bun.FFI -> proc_pidinfo(pid, PROC_PIDVNODEPATHINFO=9, ...)
// linux:  readlink(`/proc/${pid}/cwd`)
// win32:  no-op (no live badge)
//
// Cost on darwin: ~5ms across ~900 PIDs. Safe to call per /sessions request.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { readdirSync, readlinkSync } from "node:fs";

export interface LiveHolder {
  pid: number;
  exe: string;
}

const INTERESTING_BASENAMES = new Set(["claude", "node", "bun"]);

// Modern CC installs land at `~/.local/share/claude/versions/<X.Y.Z>` — the
// binary's *filename* is the version string, so basename matching alone misses
// every CLI session. Detect by path substring instead and normalize the
// reported exe to "claude" so downstream filters (api.ts) still recognize it.
function classifyExe(exe: string): { interesting: boolean; reportAs: string } {
  const base = exe.slice(exe.lastIndexOf("/") + 1);
  if (exe.includes("/claude/versions/")) return { interesting: true, reportAs: "claude" };
  if (INTERESTING_BASENAMES.has(base)) return { interesting: true, reportAs: base };
  return { interesting: false, reportAs: base };
}

interface DarwinSyms {
  listAllPids(): Int32Array;
  pidPath(pid: number): string | null;
  pidCwd(pid: number): string | null;
}

let darwin: DarwinSyms | null = null;

function loadDarwin(): DarwinSyms {
  if (darwin) return darwin;

  const PROC_ALL_PIDS = 1;
  const PROC_PIDVNODEPATHINFO = 9;
  const PROC_PIDPATHINFO_MAXSIZE = 4096;
  const PROC_VNODEPATHINFO_SIZE = 2352;
  const PVI_CDIR_PATH_OFFSET = 152;
  const MAXPATHLEN = 1024;

  const lib = dlopen("libSystem.B.dylib", {
    proc_listpids: {
      args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    proc_pidpath: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    proc_pidinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
  });
  const { proc_listpids, proc_pidpath, proc_pidinfo } = lib.symbols;
  const decoder = new TextDecoder();

  function listAllPids(): Int32Array {
    const buf = new Uint8Array(65536);
    const written = proc_listpids(PROC_ALL_PIDS, 0, ptr(buf), buf.byteLength);
    if (written <= 0) return new Int32Array(0);
    const count = Math.floor(written / 4);
    return new Int32Array(buf.buffer, 0, count).filter((p) => p > 0);
  }

  function pidPath(pid: number): string | null {
    const buf = new Uint8Array(PROC_PIDPATHINFO_MAXSIZE);
    const written = proc_pidpath(pid, ptr(buf), buf.byteLength);
    if (written <= 0) return null;
    return decoder.decode(buf.subarray(0, written));
  }

  function pidCwd(pid: number): string | null {
    const buf = new Uint8Array(PROC_VNODEPATHINFO_SIZE);
    const written = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0n, ptr(buf), buf.byteLength);
    if (written <= 0) return null;
    const pathBytes = buf.subarray(PVI_CDIR_PATH_OFFSET, PVI_CDIR_PATH_OFFSET + MAXPATHLEN);
    let len = 0;
    while (len < pathBytes.length && pathBytes[len] !== 0) len++;
    if (len === 0) return null;
    return decoder.decode(pathBytes.subarray(0, len));
  }

  darwin = { listAllPids, pidPath, pidCwd };
  return darwin;
}

function findActiveProjectCwdsDarwin(): Map<string, LiveHolder[]> {
  const out = new Map<string, LiveHolder[]>();
  let syms: DarwinSyms;
  try {
    syms = loadDarwin();
  } catch (err) {
    console.warn("[libproc-liveness] FFI load failed; returning empty map:", err);
    return out;
  }
  const pids = syms.listAllPids();
  for (const pid of pids) {
    const exe = syms.pidPath(pid);
    if (!exe) continue;
    const cls = classifyExe(exe);
    if (!cls.interesting) continue;
    const cwd = syms.pidCwd(pid);
    if (!cwd) continue;
    let arr = out.get(cwd);
    if (!arr) {
      arr = [];
      out.set(cwd, arr);
    }
    arr.push({ pid, exe: cls.reportAs });
  }
  return out;
}

function findActiveProjectCwdsLinux(): Map<string, LiveHolder[]> {
  const out = new Map<string, LiveHolder[]>();
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let exe: string;
    let cwd: string;
    let cls: ReturnType<typeof classifyExe>;
    try {
      exe = readlinkSync(`/proc/${pid}/exe`);
      cls = classifyExe(exe);
      if (!cls.interesting) continue;
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      continue;
    }
    let arr = out.get(cwd);
    if (!arr) {
      arr = [];
      out.set(cwd, arr);
    }
    arr.push({ pid, exe: cls.reportAs });
  }
  return out;
}

/**
 * Returns a map keyed by *current working directory* of every claude / node /
 * bun process on the box. A project path appearing as a key means at least one
 * such process is running in that project right now — useful as a coarse
 * "external CC is live in this project" signal.
 *
 * Pair with the freshest jsonl by mtime to identify the live writer:
 *   const cwds = findActiveProjectCwds();
 *   if (cwds.has(projectPath)) {
 *     // freshest jsonl in ~/.claude/projects/<key>/ is the live writer
 *   }
 *
 * Returns an empty map on win32 or if the OS call fails — callers should
 * treat absence as "unknown / not live."
 */
export function findActiveProjectCwds(): Map<string, LiveHolder[]> {
  if (process.platform === "darwin") return findActiveProjectCwdsDarwin();
  if (process.platform === "linux") return findActiveProjectCwdsLinux();
  return new Map();
}
