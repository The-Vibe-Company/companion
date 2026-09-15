import { Check, UserPlus } from "lucide-react";
import { discussionApi, type Companion, type DiscussionProposal } from "@/api";
import { Button } from "../ui/button";

export function InvitationCard({ discussionId, proposal, companion, onRefresh, onError }: {
  discussionId: string; proposal: DiscussionProposal; companion?: Companion;
  onRefresh: () => Promise<void>; onError: (cause: unknown) => void;
}) {
  async function answer(accept: boolean) {
    try { await discussionApi.answerProposal(discussionId, proposal.id, accept); await onRefresh(); }
    catch (cause) { onError(cause); }
  }
  return <section className="invitation-proposal"><UserPlus /><div>
    <strong>Invite {companion?.name ?? "this companion"}?</strong>
    <p>{proposal.reason}</p>
    {proposal.prompt && <blockquote>{proposal.prompt}</blockquote>}
    <div><Button size="sm" onClick={() => void answer(true)}><Check />Accept</Button><Button size="sm" variant="outline" onClick={() => void answer(false)}>Decline</Button></div>
  </div></section>;
}
