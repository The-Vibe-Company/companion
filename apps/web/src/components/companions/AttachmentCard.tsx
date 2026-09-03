"use client";

import { createContext, useContext } from "react";
import { FileTextIcon, PaperclipIcon } from "lucide-react";
import type { CompanionAttachment } from "@companion/contracts";
import { isCompanionAttachmentImage } from "@companion/contracts";
import { companionAttachmentUrl } from "../../lib/companions";

/**
 * The files one message carries, rendered inside the message itself.
 *
 * Bytes are fetched from the control plane on every request, so an image here is an ordinary
 * same-origin `img` pointing at a route that re-decides access each time it is asked. Nothing is
 * signed, nothing is inlined, and losing access to the thread stops the image loading at the next
 * request rather than at the next cache expiry.
 */

/** Which Companion the surrounding thread belongs to, so a part can name its own read route. */
export const AttachmentContext = createContext<{ companionId: string } | null>(null);

/** One file's size as a reader should see it. Shared with the composer's staged-file chips. */
export function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STORED_ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function AttachmentList({ attachments }: {
  attachments: readonly CompanionAttachment[];
}) {
  const context = useContext(AttachmentContext);
  if (attachments.length === 0 || !context) return null;

  return (
    <ul
      data-slot="companion-attachments"
      className="mt-1.5 flex w-full min-w-0 flex-wrap gap-2 first:mt-0"
    >
      {attachments.map((attachment) => {
        const image = isCompanionAttachmentImage(attachment.content_type);
        if (attachment.availability === "expired") {
          return (
            <li
              key={attachment.id}
              data-slot="expired-attachment"
              className="border-border text-muted-foreground flex min-w-0 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs"
              aria-label={`${attachment.filename}, attachment expired`}
            >
              <PaperclipIcon aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="max-w-40 truncate" title={attachment.filename}>
                {attachment.filename}
              </span>
              <span className="shrink-0">Expired</span>
            </li>
          );
        }
        // Fetchability is decided by the id, not by whether the composer still calls this message
        // "sending". A message the control plane has not stored yet carries a synthetic id, and the
        // read route rejects anything that is not a uuid -- so asking for it would render the
        // browser's broken-image glyph on the member's own message until the next poll.
        if (!STORED_ATTACHMENT_ID.test(attachment.id)) {
          return (
            <li
              key={attachment.id}
              className="border-border text-muted-foreground flex min-w-0 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs"
            >
              <PaperclipIcon aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="max-w-40 truncate" title={attachment.filename}>
                {attachment.filename}
              </span>
              <span className="shrink-0 tabular-nums">{readableSize(attachment.byte_size)}</span>
            </li>
          );
        }
        const href = companionAttachmentUrl(context.companionId, attachment.id);
        if (image) {
          return (
            // `min-w-0` is what lets `max-w-full` on the image resolve: without it the flex item
            // keeps the image's intrinsic width and overflows the message column on a phone.
            <li key={attachment.id} className="min-w-0">
              <a href={href} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element -- the bytes come from a
                    per-request authorized control-plane route, not from a configured image host. */}
                {/* A reserved box: the contract carries no pixel dimensions, so without a floor
                    the layout box is zero until the bytes decode and then jumps to its full height,
                    shifting every message below it in a bottom-anchored transcript. */}
                <img
                  src={href}
                  alt={attachment.filename}
                  loading="lazy"
                  className="border-border bg-muted max-h-64 min-h-32 max-w-full rounded-lg border object-contain"
                />
              </a>
            </li>
          );
        }
        return (
          <li key={attachment.id} className="min-w-0">
            <a
              href={href}
              download={attachment.filename}
              className="border-border hover:bg-muted flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors"
            >
              <FileTextIcon aria-hidden="true" className="size-4 shrink-0" />
              <span className="max-w-48 truncate font-medium" title={attachment.filename}>
                {attachment.filename}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {readableSize(attachment.byte_size)}
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
