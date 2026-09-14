import { Button } from "@/components/ui/button";
import { useEffect } from "react";
import { CompanionAvatar, type CompanionAvatarValue } from "@/components/CompanionAvatar";
import { ProviderMark } from "@/components/ProviderMark";
import "./LandingPage.css";

const people: Array<{ name: string; avatar: CompanionAvatarValue }> = [
  { name: "Sage", avatar: { shape: 6, color: 5, face: 0 } },
  { name: "Nova", avatar: { shape: 1, color: 2, face: 0 } },
  { name: "Bo", avatar: { shape: 6, color: 4, face: 1 } },
];

const stories = [
  { name: "June", job: "a clearer inbox", avatar: { shape: 3, color: 7, face: 0 }, did: "Summarizes the messages that matter and drafts replies for you to review in a focused discussion.", who: "“Catch me up on my emails.”" },
  { name: "Nova", job: "a head start", avatar: { shape: 1, color: 2, face: 0 }, did: "Researches a topic, compares options, and brings back a shortlist with sources you can check.", who: "“Find a place for our next weekend away.”" },
  { name: "Bo", job: "ideas into words", avatar: { shape: 6, color: 4, face: 1 }, did: "Turns scattered notes into a first draft. A document, a presentation outline, or a post, ready for your edits.", who: "“Turn these notes into something I can share.”" },
] satisfies Array<{ name: string; job: string; avatar: CompanionAvatarValue; did: string; who: string }>;

const questions = [
  ["What is an AI companion?", "An AI teammate you create and invite into discussions. It can use the apps you connect to complete tasks while each discussion keeps its own history."],
  ["Do I need to know how to code?", "No. Give your companion a name and a job in a sentence. Everything else is a conversation."],
  ["Can it do things I didn't ask for?", "It works with the accounts you explicitly grant. Its activity is written down, and you can stop active work."],
  ["Can companions work together?", "Yes. Invite the companions a discussion needs, address one directly, and follow each companion’s work and files in the same timeline."],
  ["Where does it run?", "Your companion has its own computer in the cloud. It can keep working on accepted tasks even when your laptop is closed."],
  ["Who can join the private beta?", "Access is currently limited to invited, verified email addresses."],
];

function BrandMark({ size = 30 }: { size?: number }) {
  return <CompanionAvatar name="companions.build" avatar={{ shape: 1, color: 2, face: 0 }} size={size} />;
}

function Cta({ onClick, compact = false }: { onClick: () => void; compact?: boolean }) {
  return <Button type="button" className={compact ? "landing-cta landing-cta--compact" : "landing-cta"} onClick={onClick}>{compact ? "Private beta" : "Log in to private beta"} <span aria-hidden="true">→</span></Button>;
}

export function LandingPage({ onLogin }: { onLogin: () => void }) {
  useEffect(() => {
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousTitle = document.title;
    const previousDescription = description?.content;
    document.title = "companions.build — Your AI companions";
    if (description) description.content = "AI companions that work with your apps to research, write, organize, and handle everyday tasks.";
    return () => {
      document.title = previousTitle;
      if (description && previousDescription != null) description.content = previousDescription;
    };
  }, []);

  return <main className="landing" id="main-content">
    <a className="landing-skip" href="#how-it-works">Skip to content</a>
    <header className="landing-header">
      <a className="landing-brand" href="/" aria-label="companions.build home"><BrandMark /><strong>companions<span>.build</span></strong></a>
      <nav aria-label="Main navigation">
        <a href="#how-it-works">How it works</a>
        <a href="#stories">Stories</a>
        <a href="https://github.com/The-Vibe-Company/companions.build" target="_blank" rel="noreferrer">Open source</a>
        <button type="button" onClick={onLogin}>Log in</button>
        <Cta onClick={onLogin} compact />
      </nav>
      <button className="landing-mobile-login" type="button" onClick={onLogin}>Log in</button>
    </header>

    <section className="landing-hero">
      <div className="landing-hero-copy">
        <div className="landing-badge"><i />Open source · Private beta</div>
        <h1><span>Your AI companions.</span>{" "}<span>Give them something to do.</span></h1>
        <p>Create AI teammates to research, write, organize, and handle everyday tasks. Invite the right companions into each discussion and keep every result in one place.</p>
        <div className="landing-hero-action"><Cta onClick={onLogin} /><span>Invitation required</span></div>
        <div className="landing-promises"><span>Your apps, connected</span><span>Your companions, coordinated</span><span>Your discussions, preserved</span></div>
      </div>
      <div className="landing-lineup" aria-label="Example conversation with your companions">
        <div className="landing-bubble landing-bubble--companion">I found three places for your weekend away, all within budget. Here’s how they compare.</div>
        <div className="landing-bubble landing-bubble--person">Perfect. Show me your shortlist.</div>
        {people.map((person, index) => <CompanionAvatar key={person.name} {...person} size={[130, 210, 150][index]} className={`landing-person landing-person--${index + 1}`} />)}
      </div>
    </section>

    <div className="landing-tools"><span>Works with the tools you already use</span><div>{[["gmail", "Gmail"], ["notion", "Notion"], ["slack", "Slack"], ["github", "GitHub"]].map(([provider, name]) => <span key={provider}><ProviderMark provider={provider} name={name} />{name}</span>)}</div></div>

    <section className="landing-section" id="how-it-works">
      <h2>Three steps to your first companion.</h2>
      <div className="landing-steps">
        <article><div className="landing-step-art landing-step-faces">{people.map(person => <CompanionAvatar key={person.name} {...person} size={84} />)}</div><span>1</span><h3>Name it</h3><p>Pick a face and a name. Tell your companion what you’d like help with.</p></article>
        <article><div className="landing-step-art landing-app-grid">{[["gmail", "Gmail"], ["notion", "Notion"], ["slack", "Slack"], ["github", "GitHub"]].map(([provider, name]) => <span key={provider}><ProviderMark provider={provider} name={name} /></span>)}</div><span>2</span><h3>Connect your apps</h3><p>Choose the accounts your companion can use. With Gmail, it can read messages and create drafts for you to review.</p></article>
        <article><div className="landing-step-art"><div className="landing-working"><CompanionAvatar name="Pip" avatar={{ shape: 2, color: 7, face: 1 }} size={30} />Pip is on it <i /><i /><i /></div></div><span>3</span><h3>Let it work</h3><p>Send a message, follow the work, and find the result in the same discussion.</p></article>
      </div>
    </section>

    <section className="landing-stories" id="stories"><div>
      <h2>Start with something on your list.</h2>
      <p>A few examples of what you could ask. Start with something you’ve been meaning to get to.</p>
      <div className="landing-story-grid">{stories.map(story => <article key={story.name}><CompanionAvatar name={story.name} avatar={story.avatar} size={72} /><div><h3>{story.name} <span>· {story.job}</span></h3><p>{story.did}</p></div><small>{story.who}</small></article>)}</div>
    </div></section>

    <section className="landing-control">
      <div><h2>You stay in charge.</h2><p>Choose which accounts to connect, see what your companion is doing, and stop a task whenever you need. You can open its computer and take over, too.</p></div>
      <div className="landing-question"><header><CompanionAvatar name="Bo" avatar={{ shape: 6, color: 4, face: 1 }} size={36} /><strong>Bo needs you</strong></header><p>For your weekend away, would you prefer somewhere by the sea or in the mountains?</p><div><span>By the sea</span><span>In the mountains</span></div></div>
    </section>

    <section className="landing-faq" id="questions"><h2>Questions people ask first.</h2>{questions.map(([question, answer]) => <details key={question}><summary>{question}<span aria-hidden="true">+</span></summary><p>{answer}</p></details>)}</section>

    <footer className="landing-footer">
      <div className="landing-peek" aria-hidden="true">{stories.map(story => <CompanionAvatar key={story.name} name={story.name} avatar={story.avatar} size={96} />)}</div>
      <div><h2>Your first companion is waiting.</h2><p>Private beta · Invitation required</p><Cta onClick={onLogin} /><nav aria-label="Footer"><a href="#stories">Stories</a><a href="https://github.com/The-Vibe-Company/companions.build" target="_blank" rel="noreferrer">GitHub</a><a href="#questions">Help</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="https://github.com/The-Vibe-Company/companions.build/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT license</a></nav></div>
    </footer>
  </main>;
}
