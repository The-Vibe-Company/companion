"use client";

import type {
  Companion,
  CompanionDesktop,
  CompanionRoutine,
  CompanionTrigger,
  SkillListRow,
} from "@companion/contracts";
import Link from "next/link";
import { Badge } from "../cds";
import { Icon } from "../Icon";
import { skillsRouteHref } from "../skills/route";
import { companionStatus } from "./status";
import { CompanionRoutines } from "./CompanionRoutines";
import { CompanionTriggers } from "./CompanionTriggers";
import type { CompanionTriggerAccountOption } from "./CompanionTriggerTypes";

/** One library skill this Companion may stage on its Box, named the way the Skills list names it. */
export type CompanionContextSkill = Pick<SkillListRow, "id" | "slug" | "description" | "scope">;

/**
 * What this Companion has beside its conversation: its screen and the skills it may stage on its
 * Box.
 *
 * The screen is the live Box desktop Lux drives, framed as a preview rather than a second place to
 * work: pointer events stop at the card, and the caption under it is the same authorized handoff that
 * opens the full desktop in its own tab. Every join mints its own URL, because Box rotates the stream
 * token on each state change, and the panel keeps none: closing it, moving to another Companion, and a
 * Box that stops all drop it and the next join asks again.
 *
 * The panel never wakes anything. A desktop request observes a Box and cannot resume one, so a
 * sleeping Box explains that sending a message starts it. A Viewer, who must never start a Box, is
 * never handed the panel at all.
 */
export function CompanionContext({
  companion,
  desktop,
  joining,
  error,
  openingDesktop,
  skills,
  orgId,
  routines,
  memberTimezone,
  onRoutinesChange,
  onOpenRoutineHistory,
  triggers,
  triggerAccounts = [],
  onTriggersChange,
  onOpenTriggerHistory,
  onManageTriggerProviders,
  onJoin,
  onDesktop,
  onSettings,
  onClose,
}: {
  companion: Companion;
  desktop: CompanionDesktop | null;
  joining: boolean;
  error: string | null;
  openingDesktop: boolean;
  /** The selected skills this surface could name; ids it cannot resolve are counted, not guessed. */
  skills: CompanionContextSkill[];
  orgId: string;
  routines: CompanionRoutine[];
  memberTimezone?: string | null;
  onRoutinesChange: (routines: CompanionRoutine[]) => void;
  onOpenRoutineHistory: (routine: CompanionRoutine) => void;
  triggers: CompanionTrigger[];
  triggerAccounts?: readonly CompanionTriggerAccountOption[];
  onTriggersChange: (triggers: CompanionTrigger[]) => void;
  onOpenTriggerHistory?: (trigger: CompanionTrigger) => void;
  onManageTriggerProviders?: () => void;
  onJoin: () => void;
  onDesktop: () => void;
  /** Null for a Viewer, who does not receive the runner-only context panel. */
  onSettings: (() => void) | null;
  onClose: () => void;
}) {
  const awake = companion.runtime.state === "running";
  const status = companionStatus(companion.runtime.state);
  const streamUrl = awake ? desktop?.desktop_url ?? null : null;
  const named = companion.selected_skill_ids
    .map((id) => skills.find((skill) => skill.id === id))
    .filter((skill): skill is CompanionContextSkill => skill !== undefined);
  const unnamed = companion.selected_skill_ids.length - named.length;

  return (
    <aside className="chat-context" aria-label={`${companion.name} details`}>
      <header className="chat-context__head">
        <h2>Companion details</h2>
        <button
          type="button"
          className="iconbtn chat-context__close"
          aria-label="Hide Companion details"
          onClick={onClose}
        >
          <Icon name="x" size={15} />
        </button>
      </header>

      <div className="chat-context__body">
        <section className="chat-context__block">
          <div className="chat-context__titlerow">
            <h3 className="chat-context__title">Screen</h3>
            {streamUrl && desktop?.transport && (
              <span className="chat-context__transport">{desktop.transport}</span>
            )}
          </div>
          <div className="chat-context__screen">
            {streamUrl ? (
              /*
                The desktop is another origin's document, framed with nothing granted that would let
                it act as this app: no top-level navigation, no popups, and no access to anything of
                ours. `key` is the minted URL, so a fresh join replaces the frame rather than leaving
                the previous stream on screen while the new one connects. Pointer events stop at the
                card: this is the screen to watch, and the tab below it is the screen to drive.

                Because it is only watched, it is granted nothing a driven desktop needs. The tab
                keeps clipboard, forms, modals, and pointer lock; delegating those to another origin
                for a frame nobody can click hands out capability for no reason, and this product's
                clipboard routinely holds a pasted credential.
              */
              <iframe
                key={streamUrl}
                className="chat-context__frame"
                src={streamUrl}
                title={`${companion.name}'s screen`}
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin"
                // A mouse cannot reach it and neither should a Tab: focus inside a frame nobody can
                // see a ring in, and cannot click out of, is a keyboard trap in all but name.
                tabIndex={-1}
              />
            ) : (
              <div className="chat-context__tile">
                <Icon name={awake ? "monitor" : "moon"} size={20} />
                <strong>
                  {awake
                    ? joining ? "Connecting to the desktop..." : "No desktop on screen"
                    : `${status.label} — this Box is not running`}
                </strong>
                <p>
                  {awake
                    ? joining
                      ? `Box is minting a fresh desktop for ${companion.name}.`
                      : "Reconnect to mint a fresh desktop for this Box."
                    : `Send a message to start ${companion.name} and make its screen available.`}
                </p>
              </div>
            )}
          </div>

          {error && <p className="chat-context__error" role="alert">{error}</p>}

          <p className="chat-context__caption">
            {awake ? (
              <>
                <button
                  type="button"
                  className="chat-context__link"
                  disabled={openingDesktop}
                  onClick={onDesktop}
                >
                  {companion.name}&apos;s screen · {openingDesktop ? "opening" : "open desktop"}
                </button>
                {!streamUrl && (
                  <button
                    type="button"
                    className="chat-context__link"
                    disabled={joining}
                    onClick={onJoin}
                  >
                    {joining ? "Connecting..." : "Reconnect"}
                  </button>
                )}
              </>
            ) : `Send a message to start ${companion.name}.`}
          </p>
        </section>

        <section className="chat-context__block">
          <div className="chat-context__titlerow">
            <h3 className="chat-context__title">Skills</h3>
            {onSettings && (
              <button type="button" className="chat-context__link" onClick={onSettings}>
                Manage
              </button>
            )}
          </div>
          {companion.selected_skill_ids.length === 0 ? (
            <p className="chat-context__empty">
              No Skills attached. Add Skills in settings to give this Companion specialized instructions.
            </p>
          ) : (
            <>
              <ul className="chat-context__resources">
                {named.map((skill) => (
                  <li key={skill.id} className="chat-context__resource">
                    <Link
                      className="chat-context__resource-link"
                      href={skillsRouteHref({
                        lib: skill.scope === "org" ? "org" : "mine",
                        kind: "all",
                        skill: skill.slug,
                      })}
                    >
                      <span className="chat-context__resource-head">
                        <span className="chat-context__resource-name mono">{skill.slug}</span>
                        <Badge tone="ok" dot>Enabled</Badge>
                      </span>
                      <span className="chat-context__resource-description">
                        {skill.description || "No description provided."}
                      </span>
                    </Link>
                  </li>
                ))}
                {unnamed > 0 && (
                  // Ids this reader cannot see belong to somebody's personal library; the count is
                  // honest about them rather than inventing a name for a skill they cannot read.
                  <li className="chat-context__resource chat-context__resource--quiet">
                    {unnamed} selected {unnamed === 1 ? "Skill is" : "Skills are"} not visible to you.
                  </li>
                )}
              </ul>
              <p className="chat-context__caption">
                Staged on the Box when {companion.name} starts.
              </p>
            </>
          )}
        </section>

        <CompanionRoutines
          orgId={orgId}
          companionId={companion.id}
          routines={routines}
          memberTimezone={memberTimezone}
          canEdit={onSettings !== null}
          onChange={onRoutinesChange}
          onOpenHistory={onOpenRoutineHistory}
        />

        <CompanionTriggers
          orgId={orgId}
          companionId={companion.id}
          triggers={triggers}
          accountOptions={triggerAccounts}
          memberTimezone={memberTimezone}
          canEdit={onSettings !== null}
          onChange={onTriggersChange}
          onOpenHistory={onOpenTriggerHistory}
          onManageProviders={onManageTriggerProviders}
        />
      </div>
    </aside>
  );
}
