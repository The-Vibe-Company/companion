import { describe, expect, it, vi } from "vitest";
import { sweepSkillDatabaseObjects } from "./skillDatabaseCleanup";

describe("Companion attachment object cleanup", () => {
  it("deletes one due object and acknowledges its durable expiry intent", async () => {
    const complete = vi.fn(async () => true);
    const deleteObject = vi.fn(async () => undefined);
    const expiration = {
      storageKey: "companion-attachments/org/companion/message/0-digest",
      claimToken: "00000000-0000-0000-0000-000000000009",
    };

    await expect(sweepSkillDatabaseObjects({
      claim: async () => [expiration],
      complete,
      deleteObject,
    })).resolves.toEqual({ deleted: 1, failed: 0 });
    expect(deleteObject).toHaveBeenCalledWith(expiration.storageKey, expect.any(AbortSignal));
    expect(complete).toHaveBeenCalledWith({ deletion: expiration });
  });
});
