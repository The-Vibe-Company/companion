import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Product promise:
 * A Companion on a phone stays where it is put. Nothing in the Companions stylesheet may be wider
 * than the viewport, no surface may slide in from the side, and the thread keeps the composer on
 * screen instead of letting the page pan under a finger.
 *
 * Regression caught:
 * THE-344/THE-345 — dialogs sized in `100vw` overflowed the visual viewport, a leftover `translateX`
 * enter animation slid the thread in, and the 60px rail squeezed the phone chat header until it
 * overflowed.
 *
 * Why this test is stylesheet-level:
 * The whole failure lives in CSS. There is no runtime behaviour to observe: a jsdom-class environment
 * has no layout, so the only place these promises can be defended is the declarations themselves.
 *
 * Failure proof:
 * Restoring `calc(100vw - 28px)` on any dialog, re-adding the `companions-thread-in` keyframes, or
 * dropping the phone override of the rail margin each fails one case below.
 */

const source = readFileSync(new URL("./companions.css", import.meta.url), "utf8");
/**
 * The transcript itself is written in utilities now, so the promises about the conversation are read
 * from the components that carry those classes and from the scoped Tailwind stylesheet. Everything
 * around the conversation — the shell, the header, the dialogs — is still hand-authored CSS.
 */
const chatCss = readFileSync(new URL("./chat.css", import.meta.url), "utf8");
const transcript = readFileSync(
  new URL("../components/companions/CompanionTranscript.tsx", import.meta.url),
  "utf8",
);
const thread = readFileSync(
  new URL("../components/assistant-ui/thread.tsx", import.meta.url),
  "utf8",
);
const toolRunCard = readFileSync(
  new URL("../components/companions/ToolRunCard.tsx", import.meta.url),
  "utf8",
);
const decisionCard = readFileSync(
  new URL("../components/companions/DecisionToolCard.tsx", import.meta.url),
  "utf8",
);

/** Every vendored component the thread can render, so a promise about it cannot be scoped away. */
function sourcesIn(directory: string): Array<{ name: string; source: string }> {
  const dir = new URL(`../components/${directory}/`, import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".tsx"))
    .sort()
    .map((name) => ({ name, source: readFileSync(new URL(name, dir), "utf8") }));
}

const uiSources = sourcesIn("ui");
const assistantUiSources = sourcesIn("assistant-ui");
/** Comments explain what was removed and why, so the assertions read the rules alone. */
const css = source.replace(/\/\*[\s\S]*?\*\//g, "");

interface CssRule {
  /** The at-rules this rule sits inside, outermost first. */
  at: string[];
  selectors: string[];
  declarations: string;
}

/** A stylesheet as flat rules, so a declaration can be asserted with its media context. */
function parseRules(stripped: string): CssRule[] {
  const rules: CssRule[] = [];
  const at: string[] = [];
  let prelude = "";
  let index = 0;
  while (index < stripped.length) {
    const char = stripped[index];
    if (char === "}") {
      at.pop();
      prelude = "";
      index += 1;
      continue;
    }
    if (char !== "{") {
      prelude += char;
      index += 1;
      continue;
    }
    const head = prelude.trim();
    prelude = "";
    index += 1;
    if (head.startsWith("@")) {
      at.push(head.replace(/\s+/g, " "));
      continue;
    }
    let depth = 1;
    let declarations = "";
    while (index < stripped.length) {
      const inner = stripped[index];
      if (inner === "{") depth += 1;
      if (inner === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      declarations += inner;
      index += 1;
    }
    index += 1;
    rules.push({
      at: [...at],
      selectors: head.split(",").map((selector) => selector.trim().replace(/\s+/g, " ")),
      declarations,
    });
  }
  return rules;
}

const rules = parseRules(css);

function declarationsFor(selector: string, at: string[] = []): string[] {
  return rules
    .filter((rule) =>
      rule.selectors.includes(selector)
      && rule.at.length === at.length
      && rule.at.every((entry, position) => entry === at[position]))
    .map((rule) => rule.declarations.replace(/\s+/g, " ").trim());
}

const PHONE = ["@media (max-width: 560px)"];
const DRAWER = ["@media (max-width: 820px)"];
const COARSE_POINTER = ["@media (pointer: coarse)"];

describe("Companions mobile viewport", () => {
  it("keeps the Companions home pane in the same flat full-height frame as Skills", () => {
    const [declarations] = declarationsFor(".companions-main.companions-main--home");
    expect(declarations).toContain("display: flex;");
    expect(declarations).toContain("overflow: hidden;");
    expect(declarations).toContain("padding: 0;");
    expect(declarations).toContain("background: var(--color-surface);");
  });

  it("offers the drawer opener only where the roster is a drawer", () => {
    // Desktop already shows the roster beside the home pane, so "Browse companions" would be a
    // dead duplicate there; under 820px the sidebar collapses to a rail and the button is the way in.
    expect(declarationsFor(".companions-home__browse")[0]).toContain("display: none;");
    expect(declarationsFor(".companions-home__browse", DRAWER)[0])
      .toContain("display: inline-flex;");
  });

  it("keeps the sole row-action target at 44px wherever the kebab is hosted", () => {
    // The kebab moved into the sidebar roster with the list, but it is still each row's only action
    // target, so the thumb size holds in both the coarse-pointer media and the phone-width block.
    const coarse = declarationsFor(".companions-row-menu__trigger", COARSE_POINTER)[0];
    expect(coarse).toContain("width: 44px;");
    expect(coarse).toContain("height: 44px;");

    const phone = declarationsFor(".companions-row-menu__trigger", PHONE)[0];
    expect(phone).toContain("width: 44px;");
    expect(phone).toContain("height: 44px;");
  });

  it("keeps every interactive thread-header control touch-sized on coarse pointers", () => {
    for (const selector of [".chat-head .chat-settings", ".chat-head .chat-context-toggle"]) {
      const iconControls = declarationsFor(selector, COARSE_POINTER)[0];
      expect(iconControls).toContain("width: 44px;");
      expect(iconControls).toContain("height: 44px;");
    }

    const desktop = declarationsFor(".chat-head button.chat-box", COARSE_POINTER)[0];
    expect(desktop).toContain("min-width: 44px;");
    expect(desktop).toContain("min-height: 44px;");
  });

  it("makes Companion details a full-width, touch-safe phone view", () => {
    const phonePanel = declarationsFor(".chat-context", PHONE)[0];
    expect(phonePanel).toContain("width: 100%;");
    expect(phonePanel).toContain("border-left: 0;");

    for (const selector of [".chat-context__close", ".chat-context__add"]) {
      const control = declarationsFor(selector, COARSE_POINTER)[0];
      expect(control).toContain("width: 44px;");
      expect(control).toContain("height: 44px;");
    }
    expect(declarationsFor(".chat-context__resource-link", COARSE_POINTER)[0])
      .toContain("min-height: 44px;");
    expect(declarationsFor(".chat-context__routine-actions")[0]).toContain("flex-wrap: wrap;");
    expect(declarationsFor(".chat-context__resource-head .cds-badge--ok")[0])
      .toContain("color: var(--color-fg);");
  });

  it("gives app deep links a 44px touch target without changing ordinary prose links", () => {
    const coarseDeepLink = chatCss.match(
      /@media \(pointer: coarse\), \(max-width: 560px\) \{[\s\S]*?\.aui-scope \.aui-md-deep-link \{([\s\S]*?)\n  \}/,
    )?.[1];

    expect(coarseDeepLink).toContain("display: inline-flex;");
    expect(coarseDeepLink).toContain("min-height: 44px;");
    expect(coarseDeepLink).toContain("touch-action: manipulation;");
  });

  it("sizes every dialog against its scrim instead of the viewport width", () => {
    // `100vw` counts the scrollbar and the overscroll gutter, so a dialog came out wider than what is
    // on screen and the page could be dragged sideways behind it.
    expect(css).not.toContain("100vw");

    for (const dialog of [
      ".companions-new-dialog",
      ".companions-providers-dialog",
      ".companions-plugin-dialog",
      ".companions-delete-dialog",
      ".companions-share-dialog",
    ]) {
      const [declarations] = declarationsFor(dialog);
      expect(declarations, dialog).toMatch(/width: min\(\d+px, 100%\);/);
    }
  });

  it("leaves no slide-in animation on the thread", () => {
    // THE-333 made the chat a full page; these classes are in no TSX file, and the leftover keyframe
    // is the sideways slide the report was about.
    expect(css).not.toContain("companions-thread-in");
    expect(css).not.toContain("companions-scrim-in");
    expect(css).not.toContain("companions-thread-scrim");
    // Nothing in this stylesheet may animate a surface across the screen. A keyframe that only
    // moves in place is not that, so the assertion is on what the keyframes do rather than on there
    // being none. THE-382's companion-icon gaze is the one exception: the eyes of the blob move
    // at most 2px inside their own face group, never a surface arriving from a side.
    const movingFrames = rules.filter((rule) =>
      rule.at.some((entry) => entry.startsWith("@keyframes")));
    for (const frame of movingFrames.filter((frame) =>
      !frame.at.some((entry) => entry.includes("companion-icon")))) {
      expect(frame.declarations).not.toMatch(/translate|left|right|inset|margin/);
    }
    expect(css).not.toContain("translateX(16px)");

    // The thread's own motion moved into utilities, so the promise has to follow it there or it
    // stops being a promise: this stylesheet no longer holds a single keyframe, and a loop over
    // nothing passes forever. A message or a card may rise a few pixels into place; no surface the
    // conversation is made of may arrive from the side.
    const surfaces = [transcript, thread, toolRunCard, decisionCard];
    expect(surfaces.some((source) => /slide-in-from-(top|bottom)/.test(source))).toBe(true);
    for (const source of surfaces) {
      expect(source).not.toMatch(/slide-(in-from|out-to)-(left|right|start|end)/);
    }
    // A tooltip is the one exception, and it is deliberately bounded to that one file: it is a
    // transient overlay a few pixels wide, not a surface, and it belongs to the vendored control.
    const sideSliders = uiSources
      .concat(assistantUiSources)
      .filter(({ source }) => /slide-in-from-(left|right)/.test(source))
      .map(({ name }) => name);
    expect(sideSliders).toEqual(["tooltip.tsx"]);
  });

  it("keeps the shell on the dynamic viewport and clips the inline axis", () => {
    const [declarations] = declarationsFor(".companions-app");

    expect(declarations).toContain("height: 100dvh;");
    expect(declarations).toContain("overflow-x: clip;");
    expect(declarations).not.toContain("100vh");
  });

  it("stops a flick at the end of a nested scroller instead of bouncing the page", () => {
    // The list scrolls in the main box and the thread scrolls in the log; neither may hand the
    // gesture on to the page underneath it.
    expect(declarationsFor(".companions-main")[0]).toContain("overscroll-behavior: none;");
    // On the element that actually scrolls, not merely somewhere in the file.
    expect(thread).toMatch(/aui_thread-viewport[\s\S]{0,400}?overflow-y-auto overscroll-none/);
    // The thread's own frame never scrolls: the log owns it.
    expect(declarationsFor(".companions-main--chat")[0]).toContain("overflow: hidden;");
  });

  it("gives the phone thread the whole width and pins it to the visual viewport", () => {
    // The rail is an overlay on a phone, not a column: 60px out of a 320px header is the difference
    // between a header that fits and one that overflows.
    expect(declarationsFor(".companions-app .companions-main--chat", PHONE)[0])
      .toContain("margin-left: 0;");

    const pinned = declarationsFor(".companions-app:has(.companions-main--chat)", PHONE);
    expect(pinned.join(" ")).toContain("height: var(--chat-viewport-h, 100dvh);");
    expect(pinned.join(" ")).toContain("top: var(--chat-viewport-top, 0px);");
    // The shell's own floor is a full `dvh`. Left standing, it holds the box at its pre-keyboard
    // height however short the reported viewport gets, which puts the composer back under the
    // keyboard — the exact failure this rule exists to prevent.
    expect(pinned.join(" ")).toContain("min-height: var(--chat-viewport-h, 100dvh);");
  });

  it("keeps the composer clear of the home indicator", () => {
    // The keyboard covers the home indicator, so the inset is a floor on the existing padding rather
    // than an addition to it — and it has to be on the composer root, not on some other element.
    expect(transcript).toMatch(
      /ComposerPrimitive\.Root[\s\S]{0,300}?pb-\[max\(14px,env\(safe-area-inset-bottom,0px\)\)\]/,
    );
  });

  it("keeps the Box chip's state word on a phone rather than wrapping the header", () => {
    // The chip is a dot and one word at every width; what it is about rides in its accessible name,
    // so a phone has nothing left to shorten. The word itself never gives way: status is never left
    // to the colour of the dot alone.
    expect(declarationsFor(".chat-box__state", PHONE)).toHaveLength(0);
    expect(declarationsFor(".chat-head > *")[0]).toContain("flex: none;");
  });

  it("keeps the new-message divider readable in every theme", () => {
    // `accent-edge` is an edge token: it is not lifted for the dark theme, and as small uppercase
    // text on canvas it falls under the contrast floor on every accent preset. The accent stays on
    // the hairlines; the word this divider exists for stays at full foreground contrast.
    // The divider is written in utilities now, so the promise is read from the component that
    // carries them: `text-foreground` bridges to `--color-fg`, and the accent reaches the hairlines
    // through `--color-accent-line` only.
    const divider = transcript.slice(transcript.indexOf("function NewSeparator"));
    const classes = divider.slice(0, divider.indexOf("</p>"));
    expect(classes).toContain("text-foreground");
    expect(classes).not.toContain("text-primary");
    expect(classes).not.toContain("accent-edge");
    expect(classes).toContain("before:bg-(--color-accent-line)");
    expect(classes).toContain("after:bg-(--color-accent-line)");
  });

  it("keeps the plugin row's named areas off the catalog card", () => {
    // Both surfaces use `.companions-plugin-icon`. Unscoped, `grid-area: icon` placed the card's icon
    // in an implicit track of its own: the card grew two empty columns, the description was squeezed
    // to 32px, and the icon dropped to the bottom-right corner.
    expect(declarationsFor(".companions-plugin-icon", PHONE)).toHaveLength(0);
    expect(declarationsFor(".companions-plugin-row > .companions-plugin-icon", PHONE)[0])
      .toContain("grid-area: icon;");
  });

  it("keeps branded plugin tiles after the shared icon surface", () => {
    // One-class modifiers lose to a later `.companions-plugin-icon` reset of background/color/border.
    const base = source.indexOf("\n.companions-plugin-icon {");
    const linear = source.lastIndexOf(".companions-plugin-icon--linear");
    const gmail = source.lastIndexOf(".companions-plugin-icon--gmail");
    expect(base).toBeGreaterThan(0);
    expect(linear).toBeGreaterThan(base);
    expect(gmail).toBeGreaterThan(base);
  });

  it("puts the catalog card's action under its text on a phone", () => {
    const card = declarationsFor(".companions-catalog-card", PHONE)[0];

    expect(card).toContain("grid-template-columns: 40px minmax(0, 1fr);");
    expect(card).toContain('"action action"');
    expect(declarationsFor(".companions-catalog-card > .cds-btn", PHONE)[0])
      .toContain("min-height: 40px;");
  });

  it("holds a tool run's card and its Box frame inside the thread's width", () => {
    // A command line or a desktop frame left to size itself takes its own pixels and drags the whole
    // conversation sideways on a phone. Each clause below is pinned to the element that carries it,
    // because the class existing somewhere in the file is not the promise.
    // The card itself is bound to the column it sits in.
    expect(toolRunCard).toMatch(/data-slot="companion-tool-run"[\s\S]{0,400}?\bw-full\b/);
    // The run's title shrinks before it pushes.
    expect(toolRunCard).toMatch(/min-w-0 flex-1 truncate/);
    // The disclosed body scrolls inside the card rather than widening it.
    expect(toolRunCard).toMatch(/<pre[\s\S]{0,200}?overflow-auto/);
    // The frame is a still, sized like a figure: never past the column, never past readable width.
    expect(toolRunCard).toMatch(/max-w-\[min\(100%,460px\)\][\s\S]{0,200}?src=\{run\.screenshot\}/);
    // And every image in this scope has the preflight bound underneath all of that.
    expect(chatCss).toMatch(/\.aui-scope :where\(img[^)]*\)[\s\S]*?max-width: 100%;/);
  });

  it("keeps Back and Send at a 44px thumb target", () => {
    const coarse = ["@media (pointer: coarse)"];

    expect(declarationsFor(".chat-head .chat-back", coarse)[0]).toContain("min-height: 44px;");
    // THE-346: Send is the control the composer exists for, and 32px is not a thumb target. A mouse
    // still points at the compact square. Both classes have to sit on the Send control itself.
    expect(transcript).toMatch(
      /ComposerPrimitive\.Send[\s\S]{0,600}?pointer-coarse:size-11 grid size-8/,
    );
  });
});
