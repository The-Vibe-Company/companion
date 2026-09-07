import { redirect } from "next/navigation";
import type {
  LabelsResponse,
  LocalSkillRow,
  SkillFilterPreferences,
  SkillListRow,
  BillingOverview,
  GettingStartedState,
} from "@companion/contracts";
import { loadOrgContext } from "@/lib/currentOrg";
import { serverApiFetch } from "@/lib/apiServer";
import { SkillsApp } from "@/components/skills/SkillsApp";
import {
  parseSkillsRoute,
  skillsRouteSource,
} from "@/components/skills/route";
import { AuthUnavailable, WorkspaceLoadError } from "@/components/org/WorkspaceLoadError";
import { loadServerAuth } from "@/lib/serverAuth";
import { mapSkill, type MeVM } from "@/lib/types";

export const dynamic = "force-dynamic";

const EMPTY_LABELS: LabelsResponse = { tree: [], flat: [] };

export default async function SkillsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const initialRoute = parseSkillsRoute(params);
  const initialRouteSource = skillsRouteSource(params);
  const authState = await loadServerAuth<{
    userId: string;
    email: string;
    name: string;
    avatarUrl?: string | null;
    timezone?: string | null;
    needsOnboarding?: boolean;
  }>();
  if (authState.status === "unauthenticated") redirect("/login");
  if (authState.status === "unavailable") return <AuthUnavailable />;
  const whoami = authState.user;
  if (whoami.needsOnboarding) redirect("/onboarding");
  const orgContext = await loadOrgContext().catch(() => null);
  if (!orgContext) return <WorkspaceLoadError />;
  const { orgs, current } = orgContext;
  // A user who has finished onboarding always has an org; if not, send them (back) to onboarding.
  if (!current) redirect("/onboarding");
  const orgHeaders = { "x-companion-org": current.id };
  // The Companion skill is no longer a hard gate: the install dialog opens (dismissibly) inside the
  // Companion skills view itself, so we just load the status to render that view and the sidebar dot.
  const localSkillsResult = await serverApiFetch<LocalSkillRow[]>("/v1/local-skills", { headers: orgHeaders }).catch(
    () => null,
  );

  const billing = await serverApiFetch<BillingOverview>("/v1/billing", { headers: orgHeaders }).catch(() => null);
  if (!billing) return <WorkspaceLoadError />;
  const [mineResult, orgResult, filterPreferences, personalLabelsResult, labelsResult, gettingStarted] =
    await Promise.all([
      // "My Skills": the caller's authored personal skills + org skills they installed.
      serverApiFetch<SkillListRow[]>("/v1/skills?lib=mine", { headers: orgHeaders }).catch(() => null),
      // The flat org-wide library.
      serverApiFetch<SkillListRow[]>("/v1/skills?lib=org", { headers: orgHeaders }).catch(() => null),
      serverApiFetch<SkillFilterPreferences>("/v1/skill-filter-preferences", { headers: orgHeaders }).catch(() => null),
      // Best-effort: each tree degrades gracefully to empty if its fetch fails.
      billing.entitlements.personalSkills
        ? serverApiFetch<LabelsResponse>("/v1/personal-labels", { headers: orgHeaders }).catch(() => EMPTY_LABELS)
        : Promise.resolve(EMPTY_LABELS),
      serverApiFetch<LabelsResponse>("/v1/labels", { headers: orgHeaders }).catch(() => EMPTY_LABELS),
      serverApiFetch<GettingStartedState>("/v1/getting-started", { headers: orgHeaders }).catch(() => null),
    ]);
  if (!mineResult || !orgResult || !filterPreferences) return <WorkspaceLoadError />;
  const mineSkills = mineResult.map(mapSkill);
  const orgSkills = orgResult.map(mapSkill);

  const me: MeVM = {
    id: whoami.userId,
    name: whoami.name || whoami.email || "You",
    email: whoami.email,
    initials: (whoami.name?.[0] ?? whoami.email?.[0] ?? "?").toUpperCase(),
    avatarUrl: whoami.avatarUrl ?? null,
    timezone: whoami.timezone ?? null,
  };

  return (
    <SkillsApp
      initialMineSkills={mineSkills}
      initialOrgSkills={orgSkills}
      initialLocalSkills={localSkillsResult ?? []}
      initialFilterPreferences={filterPreferences}
      initialPersonalLabels={personalLabelsResult ?? EMPTY_LABELS}
      initialLabels={labelsResult ?? EMPTY_LABELS}
      initialBilling={billing}
      initialGettingStarted={gettingStarted}
      me={me}
      orgs={orgs}
      currentOrg={current}
      initialRoute={initialRoute}
      initialRouteSource={initialRouteSource}
    />
  );
}
