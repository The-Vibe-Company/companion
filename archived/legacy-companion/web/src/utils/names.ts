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

export function generateSessionName(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj} ${noun}`;
}

export function generateUniqueSessionName(existingNames: Set<string>): string {
  for (let i = 0; i < 100; i++) {
    const name = generateSessionName();
    if (!existingNames.has(name)) return name;
  }
  return generateSessionName();
}
