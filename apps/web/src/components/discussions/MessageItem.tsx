import { FileText } from "lucide-react";
import type { AccountUser, DiscussionMessage, ThreadFile } from "@/api";
import { CompanionAvatar } from "../CompanionAvatar";
import { MessageResponse } from "../ai-elements/message";
import { cn } from "@/lib/utils";
import { dateLabel, type CompanionMap } from "./shared";

export function FileList({ files }: { files: ThreadFile[] }) {
  return files.length ? <div className="discussion-files">{files.map(file => <a className={file.mimeType.startsWith("image/") ? "discussion-file discussion-file--image" : "discussion-file"} href={file.url} key={file.id} target={file.mimeType.startsWith("image/") ? "_blank" : undefined} download={file.mimeType.startsWith("image/") ? undefined : file.name} rel="noreferrer">{file.mimeType.startsWith("image/") ? <img src={file.url} alt="" loading="lazy" /> : <FileText />}<span>{file.name}</span></a>)}</div> : null;
}

export function fileList(files: ThreadFile[]) { return files.length ? <FileList files={files} /> : null; }

export function MessageItem({ message, user, companions }: { message: DiscussionMessage; user: AccountUser; companions: CompanionMap }) {
  const author = message.role === "user" ? null : message.companionId ? companions.get(message.companionId) : null;
  return <article className={cn("discussion-message", message.role === "user" && "discussion-message--user")} data-sequence={message.sequence}>
    <div className="discussion-message-avatar">{message.role === "user" ? <span>{(user.name || user.email).slice(0, 1).toUpperCase()}</span> : author ? <CompanionAvatar name={author.name} avatar={author.avatar} size={32}/> : <span className="central-mark central-mark--small">c.</span>}</div>
    <div>
      <header><strong>{message.role === "user" ? "You" : author?.name ?? "Companion"}</strong>{message.role === "user" && <span className="message-recipient">to @{message.companionId ? companions.get(message.companionId)?.name ?? "companion" : "Companion"}</span>}<time dateTime={message.createdAt}>{dateLabel(message.createdAt)}</time>{!message.complete && <em>In progress</em>}</header>
      {message.role === "assistant" && message.delegated
        ? <details className="discussion-delegated-history"><summary>Earlier delegated response</summary><MessageResponse>{message.content}</MessageResponse>{fileList(message.files)}</details>
        : <><MessageResponse>{message.content}</MessageResponse>{fileList(message.files)}</>}
    </div>
  </article>;
}
