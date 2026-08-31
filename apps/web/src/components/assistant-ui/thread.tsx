"use client";

import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/reasoning";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import {
  ActionBarPrimitive,
  AuiIf,
  MessagePrimitive,
  ThreadPrimitive,
  type ReasoningMessagePartComponent,
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react";
import { ArrowDownIcon, CheckIcon, CopyIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useMemo,
  type ComponentType,
  type FC,
  type ReactNode,
} from "react";

/**
 * The assistant-ui registry thread (`r.assistant-ui.com/thread.json`, v0.15.14), pruned to what the
 * Companion thread offers and adapted to the surface it lives in.
 *
 * Everything removed is a capability this thread does not have — attachments and their dropzone,
 * dictation, prompt suggestions, branching, editing a sent message, or regeneration — because the
 * model runs in a remote Box that the control plane only polls. Stop is a control-plane cancel of
 * the active turn, not a stream abort: there is still no live token stream in this thread.
 * Re-fetching from the registry is an upgrade task, not a refresh: this file is the artifact.
 *
 * The one structural change from the registry layout is that the composer sits *below* the scrolling
 * viewport rather than sticky inside it. A phone keyboard shrinks the visual viewport and the shell
 * around this thread is pinned to that box, so the composer is already sitting on the keyboard's top
 * edge; putting it inside the scroller would hand that job back to the browser's own panning, which
 * is the failure THE-346 fixed.
 *
 * What survives is the ChatGPT-shaped reading experience: a viewport that anchors to the newest turn,
 * a floating scroll-to-bottom, right-aligned member bubbles, replies as markdown, reasoning and tool
 * calls behind their own disclosures, and an action bar that copies.
 */

export type ThreadComponents = {
  /** First item in the scroller; used by bounded transcripts to page backwards. */
  HistoryLoader?: ComponentType | undefined;
  /** Above the messages: the loading skeleton, or the note on an empty transcript. */
  Welcome?: ComponentType | undefined;
  /** Below the messages, inside the scroller: the typing indicator. */
  Trailer?: ComponentType | undefined;
  /** Below the viewport: the composer, or the Viewer's read-only note. */
  Footer?: ComponentType | undefined;
  /** Rendered around a member's message, which is where the author and the clock go. */
  UserMessageFrame?: ComponentType<{ children: ReactNode }> | undefined;
  /** Rendered around a Companion turn, for the same reason. */
  AssistantMessageFrame?: ComponentType<{ children: ReactNode }> | undefined;
  /** Tool UIs by name. An unregistered tool name renders nothing — see `AssistantMessage`. */
  tools?: Record<string, ToolCallMessagePartComponent | undefined> | undefined;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  /** Placed on the root, so the surface around this thread keeps owning the layout. */
  className?: string | undefined;
  /** Placed on the viewport, which is the element that actually scrolls and announces. */
  viewportProps?: React.ComponentProps<typeof ThreadPrimitive.Viewport> | undefined;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ThreadComponentsContext = createContext<ThreadComponents>(EMPTY_COMPONENTS);

const Passthrough: FC<{ children: ReactNode }> = ({ children }) => <>{children}</>;

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  className,
  viewportProps,
}) => {
  const { HistoryLoader, Welcome, Trailer, Footer } = components;
  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadPrimitive.Root
        className={cn("aui-scope bg-background flex min-h-0 flex-col", className)}
        // One reading column, the same width ChatGPT settled on, centred inside whatever room the
        // surface around this thread gives it.
        // SAFETY: React's CSSProperties omits custom properties, while this key is a fixed local
        // CSS variable rather than caller-controlled style data.
        style={{ ["--thread-max-width" as string]: "44rem" }}
      >
        <ThreadPrimitive.Viewport
          // Anchored to the bottom, which is what keeps the log following the conversation. The
          // registry anchors new turns to the top instead, and that switch also turns auto-scroll
          // off — it is replaced by a reserve that only engages while a run is streaming. Nothing
          // streams here: this thread polls, so the reserve never engages and every reply, tool
          // card, and permission card would land below the fold behind a Jump button.
          turnAnchor="bottom"
          data-slot="aui_thread-viewport"
          {...viewportProps}
          className={cn(
            "relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none scroll-smooth px-(--chat-gutter) pt-4",
            viewportProps?.className,
          )}
        >
          {/* A short conversation rests on the composer instead of floating under the header. */}
          <div className="mx-auto mt-auto flex w-full max-w-(--thread-max-width) flex-col gap-y-5 pb-2">
            {HistoryLoader ? <HistoryLoader /> : null}
            {Welcome ? <Welcome /> : null}
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
            {Trailer ? <Trailer /> : null}
          </div>
          <ThreadScrollToBottom />
        </ThreadPrimitive.Viewport>
        {Footer ? <Footer /> : null}
      </ThreadPrimitive.Root>
    </ThreadComponentsContext.Provider>
  );
};

const ThreadMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  if (role === "user") return <UserMessage />;
  if (role === "system") return <SystemMessage />;
  return <AssistantMessage />;
};

/** Only reachable while the log is scrolled away from the newest turn; the primitive disables it. */
const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Jump to the newest message"
        variant="outline"
        className="border-border bg-background hover:bg-accent sticky bottom-2 z-10 size-8 self-center rounded-full border p-1.5 shadow-[var(--shadow-sm)] disabled:hidden"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

/** Thinking, folded away. It is disclosure, not the answer, so it opens only when asked for. */
const ReasoningPart: ReasoningMessagePartComponent = (props) => (
  <ReasoningRoot variant="ghost" className="mb-1">
    <ReasoningTrigger />
    <ReasoningContent>
      <ReasoningText>
        <Reasoning {...props} />
      </ReasoningText>
    </ReasoningContent>
  </ReasoningRoot>
);

const AssistantMessage: FC = () => {
  const { tools, AssistantMessageFrame: Frame = Passthrough } = useContext(ThreadComponentsContext);
  const components = useMemo(() => ({
    Text: MarkdownText,
    Reasoning: ReasoningPart,
    // No fallback. The registry ships one, but it carries its own Allow / Deny approval bar with no
    // idea of this thread's Owner/Editor boundary, and the only tool names that can reach here are
    // the two registered above — the transcript is the only thing that produces them. An unknown
    // name rendering nothing is the safe end of that trade.
    tools: { by_name: tools ?? {} },
  }), [tools]);

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="aui-assistant-message-root motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 relative duration-150"
    >
      <Frame>
        <div className="text-foreground leading-relaxed wrap-break-word">
          <MessagePrimitive.Parts components={components} />
        </div>
      </Frame>
      <div className="flex min-h-7 items-center">
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

/**
 * Copy, and only copy. Editing, regeneration, and export each need a control-plane route this thread
 * does not have: a reply is Pi's own turn, projected from its log, not something a browser can ask to
 * be produced again.
 */
const AssistantActionBar: FC = () => {
  return (
    // Not autohidden. The registry hides the bar unless the message is hovered, and it does that by
    // rendering nothing at all — so the one action this thread has would exist for a mouse on a
    // desktop and for nobody else: a keyboard cannot tab to an absent button and a phone never fires
    // the hover at all.
    <ActionBarPrimitive.Root
      className="text-muted-foreground motion-safe:animate-in motion-safe:fade-in -ms-1.5 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy reply">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="motion-safe:animate-in motion-safe:zoom-in-75 motion-safe:fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  const { UserMessageFrame: Frame = Passthrough } = useContext(ThreadComponentsContext);
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-role="user"
      className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 flex flex-col items-end duration-150"
    >
      <Frame>
        <div className="bg-muted text-foreground max-w-[85%] rounded-2xl px-4 py-2 wrap-break-word empty:hidden">
          <MessagePrimitive.Parts />
        </div>
      </Frame>
    </MessagePrimitive.Root>
  );
};

/**
 * What happened to the run, not what anyone said: a refused message, or a turn that ended with
 * nothing to show. It stays a quiet line rather than an error banner, because the conversation
 * continues around it.
 */
const SystemMessage: FC = () => (
  <MessagePrimitive.Root
    data-slot="aui_system-message-root"
    data-role="system"
    className="text-muted-foreground text-center text-xs"
  >
    <MessagePrimitive.Parts />
  </MessagePrimitive.Root>
);
