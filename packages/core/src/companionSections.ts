import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  companionSectionSchema,
  type Companion,
  type CompanionSection,
} from "@companion/contracts";
import type { Db } from "@companion/db";

import type { ActorContext } from "./services";
import { getCompanionRuntimeView } from "./companionRuntimeApi";

const sectionRowSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  owner_id: z.string(),
  name: z.string(),
  position: z.coerce.number().int().nonnegative(),
  created_at: z.union([z.date(), z.string()]),
  updated_at: z.union([z.date(), z.string()]),
});
type SectionRow = z.infer<typeof sectionRowSchema>;
type SectionDatabase = Pick<Db, "execute">;

function rows<T>(result: Awaited<ReturnType<SectionDatabase["execute"]>>): T[] {
  // SAFETY: Drizzle's PostgreSQL execute result is iterable over the rows selected by each exact
  // capability function below; every external field is parsed before crossing this service.
  return Array.from(result as Iterable<T>);
}

function sectionRows(
  result: Awaited<ReturnType<SectionDatabase["execute"]>>,
): SectionRow[] {
  return rows<unknown>(result).map((row) => sectionRowSchema.parse(row));
}

function projectSection(row: SectionRow): CompanionSection {
  return companionSectionSchema.parse({
    ...row,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  });
}

export async function listCompanionSections(input: {
  actor: ActorContext;
  orgId: string;
  database: Db;
}): Promise<CompanionSection[]> {
  const result = await input.database.execute(sql`
    select * from public.companion_api_list_sections(${input.orgId}::uuid)
  `);
  return sectionRows(result).map(projectSection);
}

export async function createCompanionSection(input: {
  actor: ActorContext;
  orgId: string;
  name: string;
  database: Db;
}): Promise<CompanionSection> {
  const result = await input.database.execute(sql`
    select * from public.companion_api_create_section(${input.orgId}::uuid, ${input.name}::text)
  `);
  const [section] = sectionRows(result);
  if (!section) throw new Error("Companion section creation returned no row");
  return projectSection(section);
}

export async function updateCompanionSection(input: {
  actor: ActorContext;
  orgId: string;
  sectionId: string;
  name: string;
  database: Db;
}): Promise<CompanionSection> {
  const result = await input.database.execute(sql`
    select * from public.companion_api_update_section(
      ${input.orgId}::uuid, ${input.sectionId}::uuid, ${input.name}::text
    )
  `);
  const [section] = sectionRows(result);
  if (!section) throw new Error("Companion section update returned no row");
  return projectSection(section);
}

export async function deleteCompanionSection(input: {
  actor: ActorContext;
  orgId: string;
  sectionId: string;
  database: Db;
}): Promise<number> {
  const result = await input.database.execute(sql`
    select public.companion_api_delete_section(
      ${input.orgId}::uuid, ${input.sectionId}::uuid
    ) as unassigned_count
  `);
  const row = z.object({ unassigned_count: z.coerce.number().int().nonnegative() })
    .parse(rows<unknown>(result)[0]);
  return row.unassigned_count;
}

export async function reorderCompanionSections(input: {
  actor: ActorContext;
  orgId: string;
  sectionIds: string[];
  database: Db;
}): Promise<CompanionSection[]> {
  await input.database.execute(sql`
    select public.companion_api_reorder_sections(
      ${input.orgId}::uuid, ${JSON.stringify(input.sectionIds)}::jsonb
    )
  `);
  return listCompanionSections(input);
}

export async function assignCompanionSection(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  sectionId: string | null;
  database: Db;
}): Promise<Companion> {
  await input.database.execute(sql`
    select public.companion_api_assign_section(
      ${input.orgId}::uuid, ${input.companionId}::uuid, ${input.sectionId}::uuid
    )
  `);
  return getCompanionRuntimeView(input);
}
