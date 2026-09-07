import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy · Companion",
  description: "How Companion handles your information and protects your privacy.",
};

const POLICY_SECTIONS = [
  {
    heading: "Data access",
    body: "When you connect the Gmail integration, Companion requests exactly two OAuth scopes and no others: gmail.readonly (read your mailbox) and gmail.compose (create drafts). No Gmail send, delete or modify permission is ever requested, and no other Google service is accessed.",
  },
  {
    heading: "Data use",
    body: "These permissions are used solely to let your AI assistant, at your direction: search and read email threads to answer questions and summarize conversations; and create drafts in your own mailbox for you to review and send yourself. Companion never sends email on your behalf — drafts are created in your own Gmail mailbox and you send them yourself.",
  },
  {
    heading: "Data sharing",
    body: "Your Gmail data is accessed directly from Google's Gmail API through Google's hosted Gmail endpoint. It is never sold, rented, shared, transferred, or disclosed to any third party other than Google. It is never used to train machine learning models, never used for advertising, and never combined with other data. The only copy of Gmail content that exists outside Google is inside your private Companion conversation transcript, which is visible only to you and workspace members you explicitly invite, and is never shared.",
  },
  {
    heading: "Data protection",
    body: "Your OAuth access and refresh tokens are stored encrypted at rest using envelope encryption, are never returned by any API, and are never logged. All data access is scoped by organization with forced row-level security and least-privilege database roles. All transport uses TLS. You can revoke access at any time by disconnecting the Gmail integration in Companion settings or via your Google Account permissions page — revocation deletes stored credentials immediately.",
  },
  {
    heading: "Retention and deletion",
    body: "OAuth credentials are retained only while the Gmail integration remains connected. Disconnecting the integration — or revoking access from your Google Account permissions page — deletes stored credentials from our systems immediately and permanently. Gmail content referenced in a conversation transcript is retained only as long as your Companion conversation exists, and is permanently deleted when you delete the companion or the conversation. Deleting your account deletes all associated data, including stored credentials and transcripts.",
  },
] as const;

export default function PrivacyPage() {
  return (
    <div className="v10-landing v10-privacy">
      <a className="v10-skip" href="#privacy-content">Skip to content</a>
      <header className="v10-nav">
        <div className="v10-wrap v10-nav__inner">
          <Link className="v5-brand" href="/" aria-label="Companion home">
            <span className="v10-wordmark" role="img" aria-label="Companion" />
          </Link>
          <span className="v10-nav__spacer" />
          <div className="v10-nav__actions">
            <Link href="/" className="v10-btn v10-btn--ghost v10-btn--sm">
              Back to Companion
            </Link>
            <Link href="/login" className="v10-btn v10-btn--primary v10-btn--sm">
              Get started
            </Link>
          </div>
        </div>
      </header>

      <main id="privacy-content">
        <section className="v10-privacy__hero">
          <div className="v10-wrap">
            <p className="v10-kick">Companion trust</p>
            <h1 className="v10-privacy__title">Privacy Policy</h1>
            <p className="v10-privacy__intro">
              Companion is a Skills Hub with optional hosted AI teammates. This policy explains what
              information Companion processes, why it processes it, and the choices available to you.
            </p>
            <p className="v10-privacy__updated">Last updated: August 29, 2026</p>
          </div>
        </section>

        <article className="v10-wrap v10-privacy__article">
          <section className="v10-privacy__overview">
            <h2>Our approach</h2>
            <p>
              We design Companion to keep your workspace under your control. We collect and use
              information needed to provide the Skills Hub, authenticate members,
              and keep the service secure. This policy focuses on the Gmail integration and its data
              practices; your organization may also host its own Companion deployment and set additional
              rules for its workspace.
            </p>
          </section>

          {POLICY_SECTIONS.map((section) => (
            <section className="v10-privacy__section" key={section.heading}>
              <h2>{section.heading}</h2>
              <p>{section.body}</p>
            </section>
          ))}

          <section className="v10-privacy__section">
            <h2>Your choices and contact</h2>
            <p>
              You can disconnect Gmail from Companion settings or revoke it through your Google Account
              permissions page. You can delete your Companion, conversation, or account using the
              controls available in the product. For questions about this policy or a privacy request,
              contact the administrator for your Companion workspace or The Vibe Company through its
              public website.
            </p>
          </section>
        </article>
      </main>

      <footer className="v10-footer">
        <div className="v10-wrap v10-footer__inner">
          <Link className="v5-brand" href="/" aria-label="Companion home">
            <span className="v10-wordmark v10-wordmark--sm" role="img" aria-label="Companion" />
          </Link>
          <span className="v10-footer__by">Companion privacy</span>
          <span className="v10-footer__links">
            <Link href="/">Back to Companion</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
