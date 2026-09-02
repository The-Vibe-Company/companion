import { defineConfig } from "tsup";
import { cpSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configDir = fileURLToPath(new URL(".", import.meta.url));
const bundledSkillSource = resolve(configDir, "../../packages/companion-skill/skill");
const excludedSkillAsset = /(?:^|\/)(?:\.git|node_modules|__pycache__|__MACOSX|\.companion)(?:\/|$)|(?:^|\/)\.DS_Store$|\.pyc$|(?:^|\/)(?:\.companion\.lock|companion\.lock)$/;

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/companionPurge.ts",
    "src/companionV2Purge.ts",
    "src/runtimeV3AcceptanceReport.ts",
  ],
  banner: {
    js: 'import { createRequire as __companionCreateRequire } from "node:module"; const require = __companionCreateRequire(import.meta.url);',
  },
  format: ["esm"],
  // Every file is a direct Node entrypoint. Keeping them self-contained preserves the
  // `import.meta.url` CLI guard used by the one-shot purge command.
  splitting: false,
  noExternal: [/^@companion\//],
  external: ["@aws-sdk/client-s3", "@sentry/node", "postgres"],
  esbuildPlugins: [{
    name: "copy-bundled-companion-skill",
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0) return;
        cpSync(
          bundledSkillSource,
          resolve(configDir, "dist/companion-skill"),
          {
            recursive: true,
            filter: (source) => {
              if (source.split(/[\\/]/).includes("__pycache__")) return false;
              const relative = source.slice(bundledSkillSource.length).replaceAll("\\", "/");
              return !excludedSkillAsset.test(relative);
            },
          },
        );
      });
    },
  }],
  sourcemap: true,
  clean: true,
  target: "node20",
});
