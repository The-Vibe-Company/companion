import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  organizationBilling,
  instances,
  instanceEvents,
  subscriptions,
} from "./schema";

// ─── Schema export tests ─────────────────────────────────────────────────────
// Validates that all Drizzle pgTable definitions are properly exported and
// configured with the correct SQL table names, columns, and foreign keys.

describe("schema exports", () => {
  it("exports all four table definitions", () => {
    expect(organizationBilling).toBeDefined();
    expect(instances).toBeDefined();
    expect(instanceEvents).toBeDefined();
    expect(subscriptions).toBeDefined();
  });
});

describe("organizationBilling table", () => {
  it('uses "organization_billing" as the underlying SQL table name', () => {
    const config = getTableConfig(organizationBilling);
    expect(config.name).toBe("organization_billing");
  });

  it("contains all expected column names", () => {
    const config = getTableConfig(organizationBilling);
    const columnNames = config.columns.map((c) => c.name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("organization_id");
    expect(columnNames).toContain("stripe_customer_id");
    expect(columnNames).toContain("plan");
    expect(columnNames).toContain("status");
    expect(columnNames).toContain("created_at");
    expect(columnNames).toContain("updated_at");
  });

  it("has no foreign keys (references Better Auth tables by convention)", () => {
    const config = getTableConfig(organizationBilling);
    // organizationId references Better Auth's organization.id but we don't
    // create a Drizzle FK constraint since they're separate table systems.
    expect(config.foreignKeys).toHaveLength(0);
  });
});

describe("instances table", () => {
  it('uses "instances" as the underlying SQL table name', () => {
    const config = getTableConfig(instances);
    expect(config.name).toBe("instances");
  });

  it("contains the organization/owner columns for team-based ownership", () => {
    const config = getTableConfig(instances);
    const columnNames = config.columns.map((c) => c.name);
    // Organization-scoped ownership model: organizationId (required) +
    // ownerId (nullable, for personal instances) + ownerType flag.
    expect(columnNames).toContain("organization_id");
    expect(columnNames).toContain("owner_id");
    expect(columnNames).toContain("owner_type");
  });

  it("contains all infrastructure column names", () => {
    const config = getTableConfig(instances);
    const columnNames = config.columns.map((c) => c.name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("fly_machine_id");
    expect(columnNames).toContain("fly_volume_id");
    expect(columnNames).toContain("region");
    expect(columnNames).toContain("hostname");
    expect(columnNames).toContain("custom_domain");
    expect(columnNames).toContain("machine_status");
    expect(columnNames).toContain("auth_secret");
    expect(columnNames).toContain("config");
    expect(columnNames).toContain("tailscale_enabled");
    expect(columnNames).toContain("tailscale_hostname");
    expect(columnNames).toContain("has_active_crons");
    expect(columnNames).toContain("created_at");
    expect(columnNames).toContain("updated_at");
  });

  it("does not have a customer_id column (replaced by organization_id)", () => {
    const config = getTableConfig(instances);
    const columnNames = config.columns.map((c) => c.name);
    expect(columnNames).not.toContain("customer_id");
  });

  it("has no Drizzle FK constraints (organization/owner reference Better Auth tables)", () => {
    const config = getTableConfig(instances);
    // No FK constraints — organizationId and ownerId reference Better Auth
    // tables which are managed separately.
    expect(config.foreignKeys).toHaveLength(0);
  });
});

describe("instanceEvents table", () => {
  it('uses "instance_events" as the underlying SQL table name', () => {
    const config = getTableConfig(instanceEvents);
    expect(config.name).toBe("instance_events");
  });

  it("contains all expected column names", () => {
    const config = getTableConfig(instanceEvents);
    const columnNames = config.columns.map((c) => c.name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("instance_id");
    expect(columnNames).toContain("event_type");
    expect(columnNames).toContain("details");
    expect(columnNames).toContain("created_at");
  });

  it("has a foreign key referencing the instances table", () => {
    const config = getTableConfig(instanceEvents);
    expect(config.foreignKeys.length).toBeGreaterThanOrEqual(1);
    const referencesInstances = config.foreignKeys.some((fk) => {
      const name = fk.getName();
      return name.includes("instances") && name.includes("instance_events");
    });
    expect(referencesInstances).toBe(true);
  });
});

describe("subscriptions table", () => {
  it('uses "subscriptions" as the underlying SQL table name', () => {
    const config = getTableConfig(subscriptions);
    expect(config.name).toBe("subscriptions");
  });

  it("contains organization_id instead of customer_id", () => {
    const config = getTableConfig(subscriptions);
    const columnNames = config.columns.map((c) => c.name);
    // Subscriptions are scoped to organizations, not individual users.
    expect(columnNames).toContain("organization_id");
    expect(columnNames).not.toContain("customer_id");
  });

  it("contains all expected column names", () => {
    const config = getTableConfig(subscriptions);
    const columnNames = config.columns.map((c) => c.name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("organization_id");
    expect(columnNames).toContain("stripe_subscription_id");
    expect(columnNames).toContain("plan");
    expect(columnNames).toContain("status");
    expect(columnNames).toContain("current_period_end");
    expect(columnNames).toContain("created_at");
  });

  it("has no Drizzle FK constraints (organization_id references Better Auth)", () => {
    const config = getTableConfig(subscriptions);
    // No FK constraints — organizationId references Better Auth's
    // organization.id, managed separately.
    expect(config.foreignKeys).toHaveLength(0);
  });
});
