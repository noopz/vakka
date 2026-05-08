import { describe, expect, test } from "bun:test";
import { isProcessAlive } from "../src/manager/spawner.js";

describe("spawner — isProcessAlive (U3)", () => {
  test("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("returns false for an obviously-dead PID", () => {
    // PID 1 is init/launchd, always alive — pick a high impossible number.
    // PIDs above 4_000_000 are well past macOS/Linux defaults.
    expect(isProcessAlive(99_999_999)).toBe(false);
  });

  test("returns false after spawning and waiting for exit", async () => {
    const proc = Bun.spawn(["true"]);
    await proc.exited;
    // Tiny window for the kernel to reap; retry a few times.
    let alive = isProcessAlive(proc.pid);
    for (let i = 0; alive && i < 5; i++) {
      await Bun.sleep(20);
      alive = isProcessAlive(proc.pid);
    }
    expect(alive).toBe(false);
  });
});

describe("spawner — wrapper detaches into its own session (U2)", () => {
  test("spawned wrapper has different pgid than parent", async () => {
    // Spawn a tiny throwaway process using the wrapper's setsid logic. We
    // can't safely run the full wrapper.ts (it expects --session-id, MQTT,
    // etc.) so we invoke a one-liner that exercises the same FFI call and
    // reports its pgid. This proves the technique works in this env.
    const script = `
      import { dlopen, FFIType } from "bun:ffi";
      const lib = dlopen(
        process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6",
        {
          setsid: { args: [], returns: FFIType.i32 },
          getpgid: { args: ["i32"], returns: FFIType.i32 },
        },
      );
      lib.symbols.setsid();
      const pgid = lib.symbols.getpgid(0);
      console.log(JSON.stringify({ pid: process.pid, pgid }));
    `;
    const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const data = JSON.parse(out.trim());
    // After setsid, the child's pgid equals its own pid (it's the new
    // session/group leader). That's what we want — distinct from the
    // test runner's pgid.
    expect(data.pgid).toBe(data.pid);
  });
});
