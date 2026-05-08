// Map a working-directory absolute path to the directory name the Agent SDK
// uses under ~/.claude/projects/. Rule: replace every non-alphanumeric char
// with "-". Verified against real directories (e.g. /Users/example/.claude →
// -Users-example--claude — the dot becomes a dash, hence the double dash).
//
// No truncation, no hashing — earlier exploration of the minified SDK bundle
// suggested those rules, but the docs and SDK behaviour confirm a straight
// regex replace is the whole story.
export function projectKeyForCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
