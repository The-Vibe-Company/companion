// @vitest-environment jsdom
import { deleteFromMap, deleteFromSet } from "./utils.js";

describe("deleteFromMap", () => {
  it("returns same reference when key is not present", () => {
    const map = new Map<string, number>([["a", 1]]);
    const result = deleteFromMap(map, "b");
    expect(result).toBe(map);
  });

  it("returns new map without the key when key is present", () => {
    const map = new Map<string, number>([["a", 1], ["b", 2]]);
    const result = deleteFromMap(map, "a");
    expect(result).not.toBe(map);
    expect(result.has("a")).toBe(false);
    expect(result.get("b")).toBe(2);
  });
});

describe("deleteFromSet", () => {
  it("returns same reference when value is not present", () => {
    const set = new Set<string>(["a"]);
    const result = deleteFromSet(set, "b");
    expect(result).toBe(set);
  });

  it("returns new set without the value when value is present", () => {
    const set = new Set<string>(["a", "b"]);
    const result = deleteFromSet(set, "a");
    expect(result).not.toBe(set);
    expect(result.has("a")).toBe(false);
    expect(result.has("b")).toBe(true);
  });
});
