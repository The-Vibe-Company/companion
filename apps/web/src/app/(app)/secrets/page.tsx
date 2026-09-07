/* oxlint-disable anti-slop/no-runtime-typeof -- Hosted Companion removal preserves the existing Skills Hub implementation; these patterns predate this change. */
import { redirect } from "next/navigation";
import type { LabelsResponse, LocalSkillRow, OrgSettingsResponse, SecretRow, SkillListRow } from "@companion/contracts";
import { loadOrgContext } from "@/lib/currentOrg";
import { serverApiFetch } from "@/lib/apiServer";
import { AuthUnavailable, WorkspaceLoadError } from "@/components/org/WorkspaceLoadError";
import { SecretsApp } from "@/components/secrets/SecretsApp";
import { mapSkill, type MeVM } from "@/lib/types";
import { deriveTreeRows } from "@/components/skills/sidebarTree";
import { loadServerAuth } from "@/lib/serverAuth";

export const dynamic = "force-dynamic";

export default async function SecretsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const initialCreateKey = params.create === "1" && typeof params.key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(params.key)
    ? params.key
    : null;
  const authState = await loadServerAuth<{
    userId: string;
    email: string;
    name: string;
    avatarUrl?: string | null;
    needsOnboarding?: boolean;
  }>();
  if (authState.status === "unauthenticated") redirect("/login");
  if (authState.status === "unavailable") return <AuthUnavailable />;
  const whoami = authState.user;
  if (whoami.needsOnboarding) redirect("/onboarding");

  const orgContext = await loadOrgContext().catch(() => null);
  if (!orgContext) return <WorkspaceLoadError />;
  const { orgs, current } = orgContext;
  if (!current) redirect("/onboarding");
  const headers = { "x-companion-org": current.id };
  const emptyLabels: LabelsResponse = { tree: [], flat: [] };
  const [secrets, settings, mineRows, orgRows, personalLabels, orgLabels, localSkills, archivedMine, archivedOrg] = await Promise.all([
    serverApiFetch<SecretRow[]>("/v1/secrets", { headers }).catch(() => null),
    serverApiFetch<OrgSettingsResponse>("/v1/orgs/current/settings", { headers }).catch(() => null),
    serverApiFetch<SkillListRow[]>("/v1/skills?lib=mine", { headers }).catch(() => null),
    serverApiFetch<SkillListRow[]>("/v1/skills?lib=org", { headers }).catch(() => null),
    serverApiFetch<LabelsResponse>("/v1/personal-labels", { headers }).catch(() => emptyLabels),
    serverApiFetch<LabelsResponse>("/v1/labels", { headers }).catch(() => emptyLabels),
    serverApiFetch<LocalSkillRow[]>("/v1/local-skills", { headers }).catch(() => []),
    serverApiFetch<SkillListRow[]>("/v1/skills?lib=mine&archived=true", { headers }).catch(() => []),
    serverApiFetch<SkillListRow[]>("/v1/skills?lib=org&archived=true", { headers }).catch(() => []),
  ]);
  if (!secrets || !settings || !mineRows || !orgRows) return <WorkspaceLoadError />;
  const mineSkills = mineRows.map(mapSkill);
  const orgSkills = orgRows.map(mapSkill);

  const me: MeVM = {
    id: whoami.userId,
    name: whoami.name || whoami.email || "You",
    email: whoami.email,
    initials: (whoami.name?.[0] ?? whoami.email?.[0] ?? "?").toUpperCase(),
    avatarUrl: whoami.avatarUrl ?? null,
  };

  return (
    <SecretsApp
      key={current.id}
      initialSecrets={secrets}
      members={settings.members.filter((member) => !member.pending)}
      me={me}
      orgs={orgs}
      currentOrg={current}
      initialCreateKey={initialCreateKey}
      navigation={{
        mineTreeRows: deriveTreeRows(mineSkills.filter((skill) => skill.source === "authored"), personalLabels.flat),
        orgTreeRows: deriveTreeRows(orgSkills, orgLabels.flat),
        mineCount: mineSkills.length,
        orgCount: orgSkills.length,
        installedCount: mineSkills.filter((skill) => skill.source === "installed").length,
        installedUpdateCount: mineSkills.filter((skill) => skill.source === "installed" && skill.installStatus === "update").length,
        localUpdateCount: localSkills.filter((skill) => skill.status === "update").length,
        archivedCount: new Set([...archivedMine, ...archivedOrg].map((skill) => skill.id)).size,
      }}
    />
  );
}
