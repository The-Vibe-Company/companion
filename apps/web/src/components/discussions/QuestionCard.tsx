import { useState } from "react";
import { discussionApi, type DiscussionSnapshot } from "@/api";
import { Button } from "../ui/button";

const LETTERS = "ABCDEFGH";

export function QuestionCard({ discussionId, question, companionName, onRefresh, onError }: {
  discussionId: string; question: DiscussionSnapshot["tasks"][number]["questions"][number];
  companionName?: string; onRefresh: () => Promise<void>; onError: (cause: unknown) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  async function submit(value: string) {
    if (!value.trim() || pending || accepted) return;
    setPending(true); setError("");
    try { await discussionApi.answerQuestion(discussionId, question.id, value.trim()); setAccepted(true); await onRefresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not send your answer."); onError(cause); }
    finally { setPending(false); }
  }
  return <form className="discussion-question" onSubmit={event => { event.preventDefault(); void submit(answer); }}>
    <strong>{question.question}</strong>
    <small>{companionName ?? "Companion"} is waiting for your answer</small>
    {question.options.length > 0 && <div>{question.options.map((option, index) => <Button
      type="button"
      key={option}
      variant="outline"
      size="sm"
      aria-label={option}
      disabled={pending || accepted}
      onClick={() => void submit(option)}
    ><i className="option-letter" aria-hidden="true">{LETTERS[index] ?? "•"}</i>{option}</Button>)}</div>}
    <label><span>Your answer</span><input disabled={pending || accepted} value={answer} onChange={event => setAnswer(event.target.value)} /><Button size="sm" type="submit" disabled={!answer.trim() || pending || accepted}>{pending ? "Sending…" : "Answer"}</Button></label>
    {accepted && <p role="status">Answer received.</p>}
    {error && <p role="alert">{error}</p>}
  </form>;
}
