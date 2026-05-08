import { describe, expect, test } from "bun:test";
import { deriveSlug, buildSlugMap } from "../src/manager/project-slug.js";

describe("deriveSlug", () => {
  test("default depth = 2", () => {
    expect(deriveSlug("/Users/example/projects/vakka")).toBe("projects-vakka");
  });

  test("custom depth", () => {
    expect(deriveSlug("/Users/example/projects/vakka", 3)).toBe("example-projects-vakka");
  });

  test("path with fewer components than depth returns all components", () => {
    expect(deriveSlug("/foo", 2)).toBe("foo");
  });

  test("trailing slash handled", () => {
    expect(deriveSlug("/Users/example/projects/vakka/")).toBe("projects-vakka");
  });
});

describe("buildSlugMap", () => {
  test("no collisions: depth 2 wins", () => {
    const map = buildSlugMap([
      "/Users/example/projects/vakka",
      "/Users/example/projects/atlas",
      "/Users/example/work/foo",
    ]);
    expect(map.get("/Users/example/projects/vakka")).toBe("projects-vakka");
    expect(map.get("/Users/example/projects/atlas")).toBe("projects-atlas");
    expect(map.get("/Users/example/work/foo")).toBe("work-foo");
  });

  test("two-way suffix collision bumps both to depth 3", () => {
    const map = buildSlugMap([
      "/Users/example/projects/vakka",
      "/Users/alice/projects/vakka",
    ]);
    expect(map.get("/Users/example/projects/vakka")).toBe("example-projects-vakka");
    expect(map.get("/Users/alice/projects/vakka")).toBe("alice-projects-vakka");
  });

  test("only colliding cwds get bumped, others stay at depth 2", () => {
    const map = buildSlugMap([
      "/Users/example/projects/vakka",
      "/Users/alice/projects/vakka",
      "/Users/example/work/foo",
    ]);
    expect(map.get("/Users/example/work/foo")).toBe("work-foo");
    expect(map.get("/Users/example/projects/vakka")).toBe("example-projects-vakka");
    expect(map.get("/Users/alice/projects/vakka")).toBe("alice-projects-vakka");
  });

  test("duplicate cwds collapse to one entry", () => {
    const map = buildSlugMap(["/a/b", "/a/b"]);
    expect(map.size).toBe(1);
    expect(map.get("/a/b")).toBe("a-b");
  });

  test("path with < 2 components", () => {
    const map = buildSlugMap(["/foo", "/Users/example/projects/foo"]);
    expect(map.get("/foo")).toBe("foo");
    expect(map.get("/Users/example/projects/foo")).toBe("projects-foo");
  });

  test("empty input", () => {
    expect(buildSlugMap([]).size).toBe(0);
  });
});
