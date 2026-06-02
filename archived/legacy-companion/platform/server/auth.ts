import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { getDb } from "./db/index.js";
import { Resend } from "resend";

/**
 * Better Auth configuration for Companion Cloud.
 *
 * Uses the organization plugin with teams enabled to support:
 * - Organizations (teams): groups of users that share billing and instances
 * - Members with roles: owner, admin, member
 * - Teams within organizations for finer-grained grouping
 * - Invitations to join organizations
 *
 * Email verification and password reset are handled via Resend when
 * RESEND_API_KEY is set. Without it, emails are logged to console (dev mode).
 *
 * Lazy singleton pattern — matches stripe.ts. The instance is created on first
 * call to getAuth() so that env vars are read at runtime (not import time),
 * which lets tests control them via vi.resetModules().
 *
 * Required env: BETTER_AUTH_SECRET
 * Optional env: BETTER_AUTH_URL, RESEND_API_KEY, RESEND_FROM_EMAIL
 */

export type Auth = ReturnType<typeof betterAuth>;

let _auth: Auth | null = null;

/** Escape HTML special characters to prevent injection in email templates. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build a sendEmail function backed by Resend when configured,
 * or a console logger for local development.
 */
function buildEmailSender() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || "Companion Cloud <noreply@thecompanion.sh>";

  if (!apiKey) {
    console.warn("[auth] RESEND_API_KEY not set — emails will be logged to console");
    return async (to: string, subject: string, html: string) => {
      console.log(`[auth:email] To: ${to} | Subject: ${subject}`);
      console.log(`[auth:email] Body (truncated): ${html.slice(0, 200)}...`);
    };
  }

  const resend = new Resend(apiKey);
  return async (to: string, subject: string, html: string) => {
    const { error } = await resend.emails.send({ from, to, subject, html });
    if (error) {
      console.error("[auth:email] Resend error:", error);
      throw new Error(`Failed to send email: ${error.message}`);
    }
  };
}

export function getAuth(): Auth {
  if (!_auth) {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");

    const sendEmail = buildEmailSender();
    const appName = "Companion Cloud";

    _auth = betterAuth({
      secret,
      baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3458",
      trustedOrigins: (process.env.BETTER_AUTH_TRUSTED_ORIGINS || "http://localhost:5175").split(","),
      database: drizzleAdapter(getDb(), { provider: "pg" }),
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: !!process.env.RESEND_API_KEY,
        sendResetPassword: async ({ user, url }) => {
          await sendEmail(
            user.email,
            `${appName} — Reset your password`,
            `<p>Hi ${escapeHtml(user.name)},</p>
             <p>Click the link below to reset your password:</p>
             <p><a href="${url}">Reset password</a></p>
             <p>If you didn't request this, you can safely ignore this email.</p>
             <p>— ${appName}</p>`,
          );
        },
      },
      emailVerification: {
        sendOnSignUp: !!process.env.RESEND_API_KEY,
        sendVerificationEmail: async ({ user, url }) => {
          await sendEmail(
            user.email,
            `${appName} — Verify your email`,
            `<p>Hi ${escapeHtml(user.name)},</p>
             <p>Welcome to ${appName}! Please verify your email address:</p>
             <p><a href="${url}">Verify email</a></p>
             <p>— ${appName}</p>`,
          );
        },
      },
      plugins: [
        organization({
          teams: { enabled: true },
          allowUserToCreateOrganization: true,
          organizationLimit: 5,
          membershipLimit: 50,
          creatorRole: "owner",
          sendInvitationEmail: async ({ invitation, inviter, organization: org }) => {
            const acceptUrl = `${process.env.BETTER_AUTH_URL || "http://localhost:3458"}/api/auth/organization/accept-invitation?invitationId=${encodeURIComponent(invitation.id)}`;
            await sendEmail(
              invitation.email,
              `${escapeHtml(inviter.user.name)} invited you to ${escapeHtml(org.name)}`,
              `<p>Hi,</p>
               <p><strong>${escapeHtml(inviter.user.name)}</strong> invited you to join <strong>${escapeHtml(org.name)}</strong> on ${appName}.</p>
               <p><a href="${acceptUrl}">Accept invitation</a></p>
               <p>— ${appName}</p>`,
            );
          },
        }),
      ],
    }) as unknown as Auth;
  }
  return _auth!;
}
