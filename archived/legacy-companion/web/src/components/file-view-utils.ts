import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico", "bmp", "tiff", "tif",
]);

export function isImageFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

/** Map file extension to a CodeMirror language extension. */
export function langForPath(filePath: string): unknown {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "jsx":
      return javascript({ jsx: true });
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "css":
    case "scss":
    case "less":
      return css();
    case "html":
    case "htm":
    case "svelte":
    case "vue":
      return html();
    case "json":
    case "jsonc":
    case "json5":
      return json();
    case "md":
    case "mdx":
    case "markdown":
      return markdown();
    case "py":
    case "pyw":
    case "pyi":
      return python();
    case "rs":
      return rust();
    case "c":
    case "h":
    case "cpp":
    case "cxx":
    case "cc":
    case "hpp":
    case "hxx":
      return cpp();
    case "java":
      return java();
    case "sql":
      return sql();
    case "xml":
    case "xsl":
    case "xsd":
    case "svg":
      return xml();
    case "yml":
    case "yaml":
      return yaml();
    default:
      return null;
  }
}

export function relPath(cwd: string, path: string): string {
  const normalizedCwd = cwd === "/" ? "/" : cwd.replace(/\/+$/, "");

  if (normalizedCwd === "/") {
    return path.startsWith("/") ? path.slice(1) : path;
  }

  if (path.startsWith(`${normalizedCwd}/`)) return path.slice(normalizedCwd.length + 1);
  return path;
}
