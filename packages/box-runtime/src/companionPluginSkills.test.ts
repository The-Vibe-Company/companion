import { describe, expect, it } from "vitest";

import { COMPANION_PLUGIN_SKILLS } from "./companionPluginSkills";

describe("COMPANION_PLUGIN_SKILLS", () => {
  it("ships exactly the Slack, GitHub, Linear, Gmail, and Sentry plugin skills with valid frontmatter", () => {
    expect(COMPANION_PLUGIN_SKILLS.map((skill) => skill.slug)).toEqual([
      "plugin-slack",
      "plugin-github",
      "plugin-linear",
      "plugin-gmail",
      "plugin-sentry",
    ]);
    for (const skill of COMPANION_PLUGIN_SKILLS) {
      expect(skill.content.startsWith("---\n")).toBe(true);
      expect(skill.content).toContain(`name: ${skill.slug.replace(/^plugin-/, "")}-plugin`);
      expect(skill.content).toContain(`description: "`);
      expect(skill.content).not.toContain("TODO");
    }
    const triggerSkills = COMPANION_PLUGIN_SKILLS.filter(
      (skill) => skill.provider === "github" || skill.provider === "linear",
    );
    for (const skill of triggerSkills) {
      expect(skill.content).toContain("companion_request_trigger_change");
      expect(skill.content).toContain("registration");
    }
  });

  it("keeps github-specific guidance out of linear and vice versa", () => {
    const github = COMPANION_PLUGIN_SKILLS.find((skill) => skill.provider === "github")!;
    const linear = COMPANION_PLUGIN_SKILLS.find((skill) => skill.provider === "linear")!;
    const gmail = COMPANION_PLUGIN_SKILLS.find((skill) => skill.provider === "gmail")!;
    const sentry = COMPANION_PLUGIN_SKILLS.find((skill) => skill.provider === "sentry")!;
    expect(github.content).toContain("owner/repo");
    expect(github.content).toContain("git push");
    expect(linear.content).not.toContain("git push");
    expect(linear.content).toContain("Linear webhook registration");
    expect(linear.content).toContain("minimal encrypted webhook API-key credential");
    const slack = COMPANION_PLUGIN_SKILLS.find((skill) => skill.provider === "slack")!;
    expect(slack.content).toContain("slack_chat_post_message");
    expect(slack.content).toContain("does not receive Slack messages");
    expect(github.content).toContain("companion_request_trigger_change");
    expect(linear.content).toContain("companion_request_trigger_change");
    expect(gmail.content).toContain("untrusted external data");
    expect(gmail.content).toContain("cannot send email");
    expect(gmail.content).not.toContain("companion_request_trigger_change");
    expect(sentry.content).toMatch(/external untrusted\s+data/);
    expect(sentry.content).toContain("consequential write");
    expect(sentry.content).not.toContain("companion_request_trigger_change");
  });
});
