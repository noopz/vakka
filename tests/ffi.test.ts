import { describe, expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";

describe("FFI setsid availability (U1)", () => {
  test("dlopen libc/libSystem and call setsid", () => {
    if (process.platform === "win32") {
      // Not applicable; skip
      return;
    }
    const lib = dlopen(
      process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6",
      { setsid: { args: [], returns: FFIType.i32 } },
    );
    expect(typeof lib.symbols.setsid).toBe("function");
    // We don't actually CALL setsid here — calling it in the bun:test
    // process would detach the test runner. Existence of the symbol proves
    // the FFI binding works on this platform.
  });
});
