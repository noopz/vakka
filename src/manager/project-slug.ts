// Display slug for a project cwd. Distinct from projectKeyForCwd (which the
// SDK uses under ~/.claude/projects/<key>/) — this one is purely for URLs.
//
// Rule: take the last N path components, join with "-". N starts at 2 and
// climbs only when needed to break collisions across the project set.
//
// Examples:
//   /Users/example/projects/vakka              → projects-vakka         (depth 2)
//   /Users/example/projects/vakka              \
//   /Users/alice/projects/vakka            } → example-projects-vakka, alice-projects-vakka (depth 3)
//
// Pathological identical-suffix collisions get an index suffix (-1, -2, ...).

function components(cwd: string): string[] {
  return cwd.split("/").filter((p) => p.length > 0);
}

function lastN(cwd: string, n: number): string {
  const parts = components(cwd);
  return parts.slice(-n).join("-");
}

export function deriveSlug(cwd: string, depth = 2): string {
  return lastN(cwd, depth);
}

export function buildSlugMap(cwds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const remaining = new Set(cwds);
  let depth = 2;

  while (remaining.size > 0 && depth <= 8) {
    const groups = new Map<string, string[]>();
    for (const cwd of remaining) {
      const slug = lastN(cwd, depth);
      const arr = groups.get(slug) ?? [];
      arr.push(cwd);
      groups.set(slug, arr);
    }

    for (const [slug, group] of groups) {
      if (group.length === 1) {
        out.set(group[0]!, slug);
        remaining.delete(group[0]!);
      } else {
        // Check if any cwd in this group still has more components to expand.
        const allExhausted = group.every(
          (cwd) => components(cwd).length <= depth,
        );
        if (allExhausted) {
          group.forEach((cwd, i) => {
            out.set(cwd, `${slug}-${i + 1}`);
            remaining.delete(cwd);
          });
        }
        // else: leave them for next depth iteration
      }
    }

    depth++;
  }

  // Safety: any leftovers (shouldn't happen with depth<=8) get index suffixes.
  let i = 1;
  for (const cwd of remaining) {
    out.set(cwd, `${lastN(cwd, 8)}-${i++}`);
  }

  return out;
}
