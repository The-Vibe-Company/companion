import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

/**
 * Tests for the database connection singleton.
 *
 * Uses vi.resetModules() + dynamic import for each test because getDb() is a
 * lazy singleton that reads DATABASE_URL at first call. Resetting modules
 * ensures each test starts with a fresh singleton.
 */

// Mock end() so we can verify closeDb() drains the pool.
const mockEnd = vi.fn(async () => {});
// Mock postgres to avoid real TCP connections.
vi.mock("postgres", () => ({
  default: vi.fn(() => Object.assign(vi.fn(), { end: mockEnd })),
}));

// Mock drizzle-orm/postgres-js to return a fake db instance.
vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: vi.fn(() => ({ __drizzle: true })),
}));

async function freshImport() {
  vi.resetModules();
  mockEnd.mockClear();
  return import("./index.js");
}

describe("getDb", () => {
  const savedUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  // Restore after all tests in this describe.
  afterAll(() => {
    if (savedUrl !== undefined) {
      process.env.DATABASE_URL = savedUrl;
    }
  });

  it("throws when DATABASE_URL is not set", async () => {
    const { getDb } = await freshImport();
    expect(() => getDb()).toThrow("DATABASE_URL is not set");
  });

  it("returns a drizzle instance when DATABASE_URL is set", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getDb } = await freshImport();
    const db = getDb();
    expect(db).toEqual({ __drizzle: true });
  });

  it("returns the same singleton on repeated calls", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getDb } = await freshImport();
    const db1 = getDb();
    const db2 = getDb();
    expect(db1).toBe(db2);
  });

  it("closeDb drains the connection pool and resets the singleton", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getDb, closeDb } = await freshImport();

    // Initialise the singleton so the sql client is created
    getDb();
    expect(mockEnd).not.toHaveBeenCalled();

    await closeDb();
    expect(mockEnd).toHaveBeenCalledOnce();

    // After closing, getDb() creates a fresh connection
    getDb();
    expect(mockEnd).toHaveBeenCalledOnce(); // still 1 — no extra end() call
  });

  it("closeDb is a no-op when no connection exists", async () => {
    const { closeDb } = await freshImport();
    // Should not throw when called without prior getDb()
    await closeDb();
    expect(mockEnd).not.toHaveBeenCalled();
  });
});
