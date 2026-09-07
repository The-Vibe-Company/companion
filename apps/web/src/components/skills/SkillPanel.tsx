"use client";

import { useEffect, useState } from "react";
import type { LabelVM } from "@companion/contracts";
import { Icon } from "../Icon";
import { UserAvatar } from "../UserAvatar";
import { fetchSkillVersionFiles } from "@/lib/queries";
import type { SkillVM } from "@/lib/types";
import { resolveSkillListIcon } from "./listGrouping";
import { resolveSkillActions, skillActionPermissions, type SkillAction } from "./skillActions";

/** How much of `SKILL.md` the panel shows before a reader should open the file itself. */
const EXCERPT_LINES = 20;

/**
 * One selected skill, beside the list it was selected from. It answers the questions a reader has
 * while scanning — what is this, who wrote it, is it installed, what does its `SKILL.md` open with,
 * and carries the primary action for that skill.
 *
 * It is deliberately not the skill's page: the full detail, every tab, and every secondary action
 * stay behind Open, which is also what a double click on the row does. A panel that tried to be the
 * page would be a worse page in a third of the width.
 */
export function SkillPanel({
  skill,
  labels,
  actorId,
  onOpen,
  onAction,
  onClose,
}: {
  skill: SkillVM;
  labels: LabelVM[];
  actorId: string;
  onOpen: (slug: string) => void;
  onAction: (skill: SkillVM, action: SkillAction) => void;
  onClose: () => void;
}) {
  const primary = resolveSkillActions(skill, skillActionPermissions(skill, actorId)).primary;
  const icon = resolveSkillListIcon(skill, labels);
  const [excerpt, setExcerpt] = useState<string | null>(null);
  /**
   * The opening of `SKILL.md`, read from the package the list already knows the version of. It is
   * fetched when a skill is selected rather than with the list, because most rows are scrolled past.
   */
  useEffect(() => {
    setExcerpt(null);
    const version = skill.version;
    if (!version) return;
    // Reading the package means the server extracts an archive, and a reader moving down the list
    // supersedes one selection per click. The request goes with the selection that asked for it.
    const abort = new AbortController();
    fetchSkillVersionFiles(skill.id, version, { signal: abort.signal })
      .then((response) => {
        if (abort.signal.aborted) return;
        const file = response.files.find((entry) => entry.path === "SKILL.md");
        setExcerpt(file?.content?.split("\n").slice(0, EXCERPT_LINES).join("\n").trim() || null);
      })
      // A package whose files cannot be read still has a panel worth showing.
      .catch(() => {});
    return () => abort.abort();
  }, [skill.id, skill.version]);

  const filedIn = [...skill.labels].sort((left, right) => left.localeCompare(right));

  return (
    <aside className="skpanel" aria-label={`Skill ${skill.id}`}>
      <header className="skpanel__head">
        <span className="skpanel__icon" style={icon.color ? { color: icon.color } : undefined}>
          <Icon name={icon.name} size={16} />
        </span>
        <span className="skpanel__identity">
          <span className="skpanel__name mono">{skill.id}</span>
          <span className="skpanel__eyebrow">
            {skill.version ? `v${skill.version}` : "no version"}
            {" · "}
            {skill.scope === "personal" ? "My Skills" : "Organization"}
            {filedIn[0] ? ` / ${filedIn[0]}` : ""}
          </span>
        </span>
        <button
          type="button"
          className="iconbtn skpanel__close"
          aria-label="Close the skill panel"
          onClick={onClose}
        >
          <Icon name="x" size={15} />
        </button>
      </header>

      <div className="skpanel__body">
        <p className="skpanel__desc">{skill.description}</p>

        <div className="skpanel__actions">
          {primary ? (
            <button
              type="button"
              className="cds-btn cds-btn--primary cds-btn--sm"
              aria-label={`${primary.label} ${skill.id}`}
              onClick={() => onAction(skill, primary)}
            >
              <Icon name={primary.icon} size={14} />
              {primary.contextualLabel ?? primary.label}
            </button>
          ) : skill.installStatus === "installed" ? (
            <span className="skpanel__installed">
              <Icon name="circle-check" size={14} />
              Installed
            </span>
          ) : null}
          <button
            type="button"
            className="cds-btn cds-btn--secondary cds-btn--sm"
            onClick={() => onOpen(skill.id)}
          >
            Open
          </button>
        </div>

        <dl className="skpanel__meta">
          <div>
            <dt>Version</dt>
            <dd className="mono">{skill.version ?? "—"}</dd>
          </div>
          <div>
            <dt>Creator</dt>
            <dd>
              <UserAvatar
                className="avatar"
                avatarUrl={skill.authorAvatarUrl}
                initials={skill.authorInitials}
                size={18}
                style={{ fontSize: 8 }}
              />
              {skill.authorName}
            </dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{skill.updated} by {skill.updaterName}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd className="mono">{skill.size}</dd>
          </div>
        </dl>

        {filedIn.length > 0 && (
          <ul className="skpanel__chips" aria-label="Folders">
            {filedIn.map((path) => (
              <li className="skpanel__chip mono" key={path}>{path}</li>
            ))}
          </ul>
        )}

        {excerpt && (
          <section className="skpanel__block">
            <h3 className="skpanel__title">SKILL.md</h3>
            <pre className="skpanel__excerpt">{excerpt}</pre>
          </section>
        )}


      </div>
    </aside>
  );
}
