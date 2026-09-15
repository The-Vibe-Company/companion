import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { ArrowUp, FileText, LoaderCircle, Paperclip, X } from "lucide-react";
import { discussionApi, type Companion, type DiscussionSnapshot } from "@/api";
import { CompanionAvatar } from "../CompanionAvatar";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ACCEPTED_FILES, MAX_FILES, MAX_FILE_SIZE, draftKey, readDraft, targetKey, type PendingAttachment, type StoredDraft } from "./shared";

export function Composer({ userId, snapshot, companions, initialDraft, onInitialDraftApplied, onRefresh, onError }: { userId: string; snapshot: DiscussionSnapshot; companions: Companion[]; initialDraft: string | null; onInitialDraftApplied: () => void; onRefresh: () => Promise<void>; onError: (cause: unknown, fallback?: string) => void }) {
  const id = snapshot.discussion.id;
  const restored = useRef(readDraft(userId, id));
  const [draft, setDraft] = useState(restored.current?.content ?? "");
  const directId = snapshot.discussion.directCompanionId;
  const available = companions.filter(companion => !companion.retiredAt && companion.id !== directId);
  const mentionTargets: Array<{id: string | null; name: string; instructions: string; avatar?: Companion["avatar"]}> = directId ? [] : [{id:null,name:"Companion",instructions:"Coordinates this discussion"}, ...available];
  const savedTarget = (() => { try { return localStorage.getItem(targetKey(userId, id)); } catch { return null; } })();
  const [target, setTarget] = useState<string | null>(directId ?? (restored.current ? restored.current.targetCompanionId : available.some(companion => companion.id === savedTarget) ? savedTarget : null));
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [attempted,setAttempted]=useState(restored.current?.attempted??false);
  const [fileError, setFileError] = useState(restored.current?.files.length ? "Reattach the saved draft’s files before retrying." : "");
  const clientMessageId = useRef(restored.current?.clientMessageId ?? crypto.randomUUID());
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [mentionIndex,setMentionIndex]=useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const persist = useCallback((content = draft, nextTarget = target, nextFiles = files) => {
    try {
      if (!content && nextFiles.length === 0) sessionStorage.removeItem(draftKey(userId, id));
      else sessionStorage.setItem(draftKey(userId, id), JSON.stringify({ attempted, content, targetCompanionId: nextTarget, clientMessageId: clientMessageId.current, files: [...(restored.current?.files??[]).filter(saved=>!nextFiles.some(f=>f.id===saved.id)),...nextFiles.map(item => ({ id: item.id, name: item.file.name, size: item.file.size, position:item.position }))].sort((a,b)=>(a.position??0)-(b.position??0)) } satisfies StoredDraft));
    } catch { /* in-memory state remains usable */ }
  }, [draft, target, files, userId, id, attempted]);
  useEffect(() => { persist(); }, [draft, target, files, persist]);
  useEffect(()=>{if(initialDraft&&!attempted){setDraft(initialDraft);onInitialDraftApplied();requestAnimationFrame(()=>textarea.current?.focus());}},[initialDraft,attempted,onInitialDraftApplied]);

  function chooseTarget(next: string | null) { if(attempted)return;setTarget(next); try { if (next) localStorage.setItem(targetKey(userId, id), next); else localStorage.removeItem(targetKey(userId, id)); } catch { /* optional preference */ } }
  function addFiles(next: File[]) {
    setFileError("");
    setFiles(current => {
      const accepted: PendingAttachment[] = [],used=new Set(current.map(item=>item.id));
      const saved=(restored.current?.files??[]).map((item,index)=>({...item,position:item.position??index})).sort((a,b)=>a.position-b.position);
      for (const file of next) {
        const match=saved.find(item=>item.name===file.name&&item.size===file.size&&!used.has(item.id));
        if(attempted&&!match){setFileError("Retry this message with the same files, or start another message.");continue;}
        if (current.length + accepted.length >= MAX_FILES) { setFileError(`You can attach up to ${MAX_FILES} files.`); break; }
        if (file.size > MAX_FILE_SIZE) { setFileError(`${file.name} is larger than 10 MiB.`); continue; }
        const id=match?.id??crypto.randomUUID(),position=match?.position??Math.max(-1,...current.map(item=>item.position),...accepted.map(item=>item.position))+1;
        used.add(id);accepted.push({file,id,position});
      }
      return [...current,...accepted].sort((a,b)=>a.position-b.position);
    });
  }
  function mention(companion: (typeof mentionTargets)[number]) {
    if(attempted)return;
    setDraft(current => current.replace(/(^|\s)@[^\s@]*$/, "$1"));
    chooseTarget(companion.id);
    setMentionIndex(0);
    requestAnimationFrame(() => textarea.current?.focus());
  }
  function updateDraft(content: string) {
    setDraft(content);
    const normalized = content.toLocaleLowerCase();
    const mentioned = mentionTargets.map(companion => {
      const token = '@' + companion.name.toLocaleLowerCase(), index = normalized.lastIndexOf(token);
      const matched = index >= 0 && (index === 0 || /\s/.test(normalized[index - 1])) && (index + token.length === normalized.length || /[\s.,!?;:]/.test(normalized[index + token.length]));
      return {companion,index:matched?index:-1};
    }).filter(match=>match.index>=0).sort((a,b)=>b.index-a.index||b.companion.name.length-a.companion.name.length)[0];
    if (mentioned && content.slice(0, mentioned.index + mentioned.companion.name.length + 1) !== draft.slice(0, mentioned.index + mentioned.companion.name.length + 1)) chooseTarget(mentioned.companion.id);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if ((!draft.trim() && !files.length) || sending) return;
    if(restored.current?.files.some(saved=>!files.some(f=>f.id===saved.id))){setFileError("Reattach all saved files before retrying.");return;}
    setSending(true); setAttempted(true); setFileError(""); persist();
    try {
      await discussionApi.sendMessage(id, { clientMessageId: clientMessageId.current, content: draft.trim(), targetCompanionId: directId ? undefined : target, files: [...files].sort((a,b)=>a.position-b.position) });
      setAttempted(false); setDraft(""); setFiles([]); clientMessageId.current = crypto.randomUUID(); restored.current = null;
      try { sessionStorage.removeItem(draftKey(userId, id)); } catch { /* no-op */ }
      await onRefresh();
    } catch (cause) { onError(cause, "Could not send. Your draft is saved; retry sends the same request."); }
    finally { setSending(false); }
  }
  const targetCompanion = companions.find(companion => companion.id === target);
  const mentionMatch=!attempted&&!directId&&!mentionDismissed?draft.match(/(?:^|\s)@([^\s@]*)$/):null;
  const mentionOptions=mentionMatch?mentionTargets.filter(companion=>companion.name.toLocaleLowerCase().startsWith(mentionMatch[1].toLocaleLowerCase())):[];
  return <form className="discussion-composer" onSubmit={submit} onDrop={(event: DragEvent) => { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); }} onDragOver={event => event.preventDefault()}>
    {files.length > 0 && <div className="composer-files">{files.map(item => <span key={item.id}><FileText />{item.file.name}<button type="button" disabled={attempted} aria-label={`Remove ${item.file.name}`} onClick={() => setFiles(current => current.filter(file => file.id !== item.id))}><X /></button></span>)}</div>}
    {attempted&&!sending&&<p className="composer-file-error">Retry sends the same message. <button type="button" onClick={()=>{setAttempted(false);setDraft('');setFiles([]);setFileError('');restored.current=null;clientMessageId.current=crypto.randomUUID();}}>Start another message</button></p>}
    {fileError && <p className="composer-file-error" role="alert">{fileError}</p>}
    <div className="composer-recipient"><span>To</span><div className="recipient-control">{targetCompanion ? <CompanionAvatar name={targetCompanion.name} avatar={targetCompanion.avatar} size={22}/> : <span className="central-mark central-mark--pill" aria-hidden="true">c</span>}{directId ? <strong>@{targetCompanion?.name ?? "companion"}</strong> : <select disabled={attempted} aria-label="Message recipient" value={target ?? ""} onChange={event => chooseTarget(event.target.value || null)}><option value="">@Companion</option>{available.map(companion => <option value={companion.id} key={companion.id}>@{companion.name}</option>)}</select>}</div><span className="recipient-hint">{directId ? "Direct conversation" : targetCompanion && !snapshot.participants.some(participant => participant.companionId === target && !participant.removedAt) ? "Joins when you send" : targetCompanion ? "Replies in this thread" : "Coordinates this discussion"}</span></div>
    {mentionOptions.length>0&&<div id={`${id}-mention-list`} className="mention-autocomplete" role="listbox" aria-label="Companion suggestions">{mentionOptions.map((companion,index)=><button id={`${id}-mention-${companion.id??"coordinator"}`} type="button" role="option" aria-selected={index===mentionIndex} key={companion.id??"coordinator"} onMouseDown={event=>event.preventDefault()} onClick={()=>mention(companion)}><>{companion.id ? <CompanionAvatar name={companion.name} avatar={companion.avatar} size={30}/> : <span className="central-mark central-mark--small">c.</span>}</><span><strong>{companion.name}</strong><small>{companion.id === null ? "Coordinates this discussion" : snapshot.participants.some(participant => participant.companionId === companion.id && !participant.removedAt) ? "In this discussion" : "Invite and message"}</small></span>{index===mentionIndex&&<kbd>Enter</kbd>}</button>)}</div>}
    <Textarea aria-autocomplete={directId ? undefined : "list"} aria-controls={mentionOptions.length ? `${id}-mention-list` : undefined} aria-activedescendant={mentionOptions.length ? `${id}-mention-${(mentionOptions[mentionIndex] ?? mentionOptions[0]).id??"coordinator"}` : undefined} readOnly={attempted} ref={textarea} value={draft} onChange={event => {updateDraft(event.target.value);setMentionIndex(0);setMentionDismissed(false);}} onPaste={event => addFiles(Array.from(event.clipboardData.items).filter(item => item.kind === "file").map(item => item.getAsFile()).filter((file): file is File => Boolean(file)))} onKeyDown={event => { if(event.nativeEvent.isComposing)return; if(mentionOptions.length&&(event.key==="ArrowDown"||event.key==="ArrowUp")){event.preventDefault();setMentionIndex(current=>(current+(event.key==="ArrowDown"?1:-1)+mentionOptions.length)%mentionOptions.length);return;} if(mentionOptions.length&&(event.key==="Enter"||event.key==="Tab")&&!event.shiftKey){event.preventDefault();mention(mentionOptions[mentionIndex]??mentionOptions[0]);return;} if(event.key==="Escape"&&mentionOptions.length){event.preventDefault();setMentionDismissed(true);return;} if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} aria-label={directId ? `Message ${targetCompanion?.name ?? "companion"}` : targetCompanion ? `Message ${targetCompanion.name}` : "Message Companion"} placeholder={targetCompanion ? `Message ${targetCompanion.name}…` : "Ask Companion… Type @ to choose an agent"} rows={2}/>
    <footer><span>Enter to send · @ to choose an agent</span><label aria-label="Attach files"><Paperclip /><input type="file" multiple accept={ACCEPTED_FILES} onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }}/></label><Button className="composer-send" type="submit" size="icon" disabled={(!draft.trim() && !files.length) || sending} aria-label="Send message">{sending ? <LoaderCircle className="spin" /> : <ArrowUp />}</Button></footer>
  </form>;
}
