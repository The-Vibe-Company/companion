import { generateSessionName, generateUniqueSessionName } from "./names.js";

describe("generateSessionName", () => {
  it("returns a string with two words separated by a space", () => {
    const name = generateSessionName();
    const parts = name.split(" ");
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it("returns names where both words are capitalized", () => {
    // Run multiple times to increase confidence
    for (let i = 0; i < 20; i++) {
      const name = generateSessionName();
      const [adj, noun] = name.split(" ");
      expect(adj[0]).toBe(adj[0].toUpperCase());
      expect(noun[0]).toBe(noun[0].toUpperCase());
    }
  });

  it("produces different results across multiple calls (statistical)", () => {
    const names = new Set<string>();
    for (let i = 0; i < 10; i++) {
      names.add(generateSessionName());
    }
    // With 40 adjectives * 40 nouns = 1600 combinations, getting the same result
    // 10 times in a row is astronomically unlikely (1/1600^9)
    expect(names.size).toBeGreaterThan(1);
  });
});

describe("generateUniqueSessionName", () => {
  it("returns a name not in the existing set", () => {
    const existing = new Set(["Swift Falcon", "Calm River", "Bold Cedar"]);
    const name = generateUniqueSessionName(existing);
    expect(existing.has(name)).toBe(false);
    // Should still be a valid two-word name
    expect(name.split(" ")).toHaveLength(2);
  });

  it("returns a valid name when given an empty set", () => {
    const name = generateUniqueSessionName(new Set());
    const parts = name.split(" ");
    expect(parts).toHaveLength(2);
    expect(parts[0][0]).toBe(parts[0][0].toUpperCase());
    expect(parts[1][0]).toBe(parts[1][0].toUpperCase());
  });

  it("returns a name even when nearly all combinations are taken", () => {
    // Build a large existing set missing just a few combinations
    const adjectives = [
      "Swift", "Calm", "Bold", "Bright", "Warm", "Keen", "Vast", "Crisp", "Agile", "Noble",
      "Vivid", "Lucid", "Brisk", "Deft", "Fleet", "Grand", "Lush", "Prime", "Sage", "True",
      "Clear", "Deep", "Fair", "Firm", "Glad", "Kind", "Pure", "Rich", "Safe", "Wise",
      "Fresh", "Sharp", "Steady", "Quick", "Gentle", "Silent", "Golden", "Radiant", "Serene", "Verdant",
    ];
    const nouns = [
      "Falcon", "River", "Cedar", "Stone", "Ember", "Frost", "Bloom", "Ridge", "Crane", "Birch",
      "Coral", "Dawn", "Flint", "Grove", "Heron", "Lark", "Maple", "Opal", "Pearl", "Quartz",
      "Reef", "Sage", "Tide", "Vale", "Wren", "Aspen", "Brook", "Cliff", "Delta", "Eagle",
      "Fern", "Harbor", "Iris", "Jade", "Lotus", "Mesa", "Nova", "Orbit", "Pebble", "Summit",
    ];

    const existing = new Set<string>();
    for (const adj of adjectives) {
      for (const noun of nouns) {
        existing.add(`${adj} ${noun}`);
      }
    }
    // Remove a few so there's something to return
    existing.delete("Swift Falcon");
    existing.delete("Calm River");
    existing.delete("Bold Cedar");

    const name = generateUniqueSessionName(existing);
    // It should return a string (the function always returns something)
    expect(typeof name).toBe("string");
    expect(name.split(" ")).toHaveLength(2);
  });

  it("retries when collisions occur (mocked Math.random)", () => {
    const adjectives = [
      "Swift", "Calm", "Bold", "Bright", "Warm", "Keen", "Vast", "Crisp", "Agile", "Noble",
      "Vivid", "Lucid", "Brisk", "Deft", "Fleet", "Grand", "Lush", "Prime", "Sage", "True",
      "Clear", "Deep", "Fair", "Firm", "Glad", "Kind", "Pure", "Rich", "Safe", "Wise",
      "Fresh", "Sharp", "Steady", "Quick", "Gentle", "Silent", "Golden", "Radiant", "Serene", "Verdant",
    ];
    const nouns = [
      "Falcon", "River", "Cedar", "Stone", "Ember", "Frost", "Bloom", "Ridge", "Crane", "Birch",
      "Coral", "Dawn", "Flint", "Grove", "Heron", "Lark", "Maple", "Opal", "Pearl", "Quartz",
      "Reef", "Sage", "Tide", "Vale", "Wren", "Aspen", "Brook", "Cliff", "Delta", "Eagle",
      "Fern", "Harbor", "Iris", "Jade", "Lotus", "Mesa", "Nova", "Orbit", "Pebble", "Summit",
    ];

    // Math.random returning 0 will produce adjectives[0] + nouns[0] = "Swift Falcon"
    // After 3 collisions (6 calls to Math.random), return different values for a unique name
    const collisionName = `${adjectives[0]} ${nouns[0]}`; // "Swift Falcon"
    const existing = new Set([collisionName]);

    let callCount = 0;
    const originalRandom = Math.random;
    Math.random = () => {
      callCount++;
      // First 6 calls (3 iterations x 2 calls each) return 0 -> "Swift Falcon"
      if (callCount <= 6) return 0;
      // After that, return 0.5 to pick a different name
      return 0.5;
    };

    try {
      const name = generateUniqueSessionName(existing);
      // It should have retried (more than 2 calls to Math.random)
      expect(callCount).toBeGreaterThan(2);
      // The returned name should not be in the existing set
      expect(name).not.toBe(collisionName);
      // Should still be a valid two-word name
      expect(name.split(" ")).toHaveLength(2);
    } finally {
      Math.random = originalRandom;
    }
  });
});
