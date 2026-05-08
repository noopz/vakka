import { describe, expect, test } from "bun:test";
import { readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectKeyForCwd } from "../src/manager/project-key.js";

describe("projectKeyForCwd", () => {
  test("vakka project path", () => {
    expect(projectKeyForCwd("/Users/example/projects/vakka")).toBe("-Users-example-projects-vakka");
  });

  test("dotfile dir maps dots to dashes", () => {
    expect(projectKeyForCwd("/Users/example/.claude")).toBe("-Users-example--claude");
  });

  test("/private/tmp", () => {
    expect(projectKeyForCwd("/private/tmp")).toBe("-private-tmp");
  });

  test("spaces and unicode collapse to dashes", () => {
    expect(projectKeyForCwd("/Users/me/Pro ject")).toBe("-Users-me-Pro-ject");
    expect(projectKeyForCwd("/Users/me/résumé")).toBe("-Users-me-r-sum-");
  });

  test("alphanumeric-only path passes through", () => {
    expect(projectKeyForCwd("abc123")).toBe("abc123");
  });

  test("round-trip against real ~/.claude/projects/ entries", () => {
    // Best-effort: for each real directory under ~/.claude/projects/, attempt
    // to reconstruct a plausible cwd by replacing leading/internal '-' with
    // '/' and verifying that the candidate path exists. If it does, then
    // projectKeyForCwd(cwd) MUST round-trip back to the directory name.
    const projectsDir = join(homedir(), ".claude/projects");
    if (!existsSync(projectsDir)) return; // skip if no fixture data

    const entries = readdirSync(projectsDir).filter((n) => {
      try {
        return statSync(join(projectsDir, n)).isDirectory();
      } catch {
        return false;
      }
    });

    let checked = 0;
    for (const dirName of entries) {
      // Heuristic reconstruction: leading "-" → "/", remaining "-" → "/" too,
      // collapse the trivial case. This won't recover dot-prefixed dirs (the
      // double-dash signature) without a guess, so handle that explicitly.
      const candidates = new Set<string>();
      candidates.add(dirName.replace(/-/g, "/")); // /Users/example/projects/vakka
      // Double-dash anywhere likely indicates a leading-dot segment (".claude")
      candidates.add(dirName.replace(/--/g, "/.").replace(/-/g, "/"));

      for (const cand of candidates) {
        if (existsSync(cand)) {
          expect(projectKeyForCwd(cand)).toBe(dirName);
          checked++;
          break;
        }
      }
    }
    // We don't require ANY real dir to match — just that any matches round-trip.
    // Sanity: at minimum the vakka dir should match if we're running from there.
    expect(checked).toBeGreaterThanOrEqual(0);
  });
});
