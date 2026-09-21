// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "vite";
import { expect, it } from "vitest";
import { chromeBinary } from "../test/browser";
import { Message, MessageContent, MessageResponse } from "./ai-elements/message";

it("shows Markdown list markers after Tailwind preflight without changing UI lists", async () => {
  // jsdom does not implement the CSS cascade layers used by Tailwind preflight.
  // Compile the actual styles and inspect the rendered component in a real browser.
  const bundle = await build({
    logLevel: "silent",
    build: {
      write: false,
      rollupOptions: { input: ["src/index.css", "src/components/discussions/styles/index.css"] },
    },
  });
  const css = (Array.isArray(bundle) ? bundle : [bundle])
    .flatMap(output => "output" in output ? output.output : [])
    .filter(asset => asset.type === "asset" && asset.fileName.endsWith(".css"))
    .map(asset => asset.type === "asset" ? String(asset.source) : "").join("\n");
  expect(css).not.toBe("");
  const markdown = "- Bullet one\n  1. Nested number\n- Bullet two\n\n3. Number three\n   - Nested bullet\n4. Number four\n\n- [x] Done\n- [ ] Pending";
  const response = <MessageResponse>{markdown}</MessageResponse>;
  const html = renderToStaticMarkup(<>
    <Message from="assistant"><MessageContent className="thread-content">{response}</MessageContent></Message>
    <div className="discussion-task"><section>{response}</section></div>
    <div className="work-panel"><section>{response}</section></div>
    <nav><ul><li>UI bullet</li></ul><ol><li>UI number</li></ol></nav>
  </>);
  const directory = mkdtempSync(path.join(tmpdir(), "markdown-lists-"));
  try {
    const file = path.join(directory, "index.html");
    writeFileSync(file, `<!doctype html><meta charset="utf-8"><style>${css}</style>${html}
      <script>
        const lists = [...document.querySelectorAll('ul, ol')].map(list => {
          const style = getComputedStyle(list);
          const item = list.querySelector('li');
          return {
            markdown: !!list.closest('.markdown-body'),
            tag: list.tagName,
            type: style.listStyleType,
            position: style.listStylePosition,
            indent: parseFloat(style.paddingLeft) / parseFloat(style.fontSize),
            display: getComputedStyle(item).display,
            nestedIndent: list.parentElement.tagName !== 'LI' || item.getBoundingClientRect().left > list.parentElement.getBoundingClientRect().left,
          };
        });
        const result = document.createElement('pre');
        result.id = 'browser-result';
        result.textContent = JSON.stringify({
          lists,
          orderedStarts: document.querySelectorAll('ol[start="3"]').length,
          disabledCheckboxes: document.querySelectorAll('input[type="checkbox"]:disabled').length,
          checkedCheckboxes: document.querySelectorAll('input[type="checkbox"]:checked').length,
        });
        document.body.append(result);
      </script>`);
    const output = execFileSync(chromeBinary(), [
      "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--disable-component-update", "--disable-extensions", "--disable-sync",
      `--user-data-dir=${path.join(directory, "profile")}`, "--dump-dom", pathToFileURL(file).href,
    ], { encoding: "utf8", timeout: 45_000, stdio: ["ignore", "pipe", "pipe"] });
    const result = JSON.parse(output.match(/<pre id="browser-result">(.*?)<\/pre>/)![1]);
    const { lists } = result;
    expect(lists).toHaveLength(17);
    for (const list of lists) {
      expect.soft(list.type).toBe(list.markdown ? (list.tag === "UL" ? "disc" : "decimal") : "none");
      if (list.markdown) {
        expect(list.position).toBe("outside");
        expect(list.indent).toBeCloseTo(1.35, 2);
        expect(list.display).toBe("list-item");
        expect(list.nestedIndent).toBe(true);
      }
    }
    expect(result.orderedStarts).toBe(3);
    expect(result.disabledCheckboxes).toBe(6);
    expect(result.checkedCheckboxes).toBe(3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
