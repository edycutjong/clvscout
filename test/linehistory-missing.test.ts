/**
 * Covers loadLineHistory's guard: when fixtures/line-history.json is absent it
 * must throw a build-directive error, never silently return an empty set. We
 * force the absence by mocking fs.existsSync -> false (isolated to this file).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs") & { default: typeof import("node:fs") };
  return {
    ...actual,
    existsSync: () => false,
    default: { ...actual.default, existsSync: () => false },
  };
});

import { loadLineHistory } from "../data/lineHistory";

describe("loadLineHistory — missing fixture", () => {
  it("throws a directive to run gen-line-history when the file does not exist", () => {
    expect(() => loadLineHistory()).toThrow(/gen-line-history/);
  });
});
