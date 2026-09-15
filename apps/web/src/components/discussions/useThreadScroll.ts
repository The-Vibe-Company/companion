import { useLayoutEffect, useRef, useState } from "react";

/** Follow the newest message, and keep the reading position when older pages are prepended. */
export function useThreadScroll(dependencies: unknown[], olderCount: number) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const previousScroll = useRef({ height: 0, olderCount: 0 });
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || !timeline.clientHeight) return;
    if (followLatest.current) timeline.scrollTop = timeline.scrollHeight;
    else if (olderCount !== previousScroll.current.olderCount) timeline.scrollTop += timeline.scrollHeight - previousScroll.current.height;
    previousScroll.current = { height: timeline.scrollHeight, olderCount };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
  function onScroll(node: HTMLElement) {
    followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
    setAwayFromLatest(!followLatest.current);
  }
  function jumpToLatest() {
    const node = timelineRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    followLatest.current = true;
    setAwayFromLatest(false);
  }
  return { timelineRef, awayFromLatest, onScroll, jumpToLatest };
}
