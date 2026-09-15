import type { Companion } from "@/api";

const STARTERS = ["Plan a new project", "Research a decision", "Turn an idea into a draft"];

export function EmptyState({ direct, onStarter }: { direct: Companion | null | undefined; onStarter: (value: string) => void }) {
  return <div className="discussion-empty">
    <div className="central-mark">c.</div>
    <h2>{direct ? `Start a conversation with ${direct.name}` : "What are we working on?"}</h2>
    <p>{direct ? `This is a private, direct history with ${direct.name}.` : "Describe the outcome you want. Companion can bring in the right companions as the work develops."}</p>
    {!direct && <div className="discussion-starters">{STARTERS.map(value => <button key={value} onClick={() => onStarter(value)}>{value}</button>)}</div>}
  </div>;
}
