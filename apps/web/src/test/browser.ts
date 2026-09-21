import { spawn } from "node:child_process";
import { accessSync, constants, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const chromeNames = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];

/**
 * Pick a Chrome/Chromium executable: CHROME_BIN wins, then the usual binary names on
 * PATH, so a machine with only `chromium` installed needs no environment override.
 */
export function chromeBinary(): string {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const name of chromeNames) {
    for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(directory, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch { continue; }
    }
  }
  return chromeNames[0];
}

/** Drive the installed Chrome through CDP so mobile widths aren't clamped to 500px. */
export async function renderInBrowser({ url, profile, width, height, screenshot, reducedMotion = false }: {
  url: string; profile: string; width: number; height: number; screenshot?: string; reducedMotion?: boolean;
}) {
  const browser = spawn(chromeBinary(), [
    "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
    "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--disable-sync",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<void>(resolve => { browser.on("exit", () => resolve()); browser.on("error", () => resolve()); });
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      timer = setTimeout(() => reject(new Error("Chrome did not expose its debugging endpoint")), 10_000);
      browser.once("error", reject);
      browser.stderr.on("data", data => { output += String(data); const match = output.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
      browser.once("exit", code => reject(new Error(`Chrome exited before connecting (${code})`)));
    });
    socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("Chrome connection failed")), { once: true }); });
    let nextId = 0;
    const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
    socket.addEventListener("message", event => {
      const reply = JSON.parse(String(event.data));
      const entry = pending.get(reply.id);
      if (!entry) return;
      pending.delete(reply.id);
      if (reply.error) entry.reject(new Error(reply.error.message)); else entry.resolve(reply.result);
    });
    const command = (method: string, params = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome command timed out: ${method}`)); }, 10_000);
      pending.set(id, {
        resolve: result => { clearTimeout(timeout); resolve(result); },
        reject: error => { clearTimeout(timeout); reject(error); },
      });
      socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { targetId } = await command("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await command("Target.attachToTarget", { targetId, flatten: true });
    await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 500 }, sessionId);
    if (width < 500) await command("Emulation.setTouchEmulationEnabled", { enabled: true }, sessionId);
    await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" }] }, sessionId);
    await command("Page.navigate", { url }, sessionId);
    for (let attempt = 0; attempt < 300; attempt++) {
      const result = await command("Runtime.evaluate", { expression: "document.querySelector('#browser-result') ? document.documentElement.outerHTML : null", returnByValue: true }, sessionId);
      if (result.result.value) {
        if (screenshot) {
          const capture = await command("Page.captureScreenshot", { format: "png" }, sessionId);
          writeFileSync(screenshot, Buffer.from(capture.data, "base64"));
        }
        return String(result.result.value);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("The page did not produce a browser report");
  } finally {
    clearTimeout(timer);
    socket?.close();
    browser.kill("SIGTERM");
    const kill = setTimeout(() => browser.kill("SIGKILL"), 3_000);
    await exited; clearTimeout(kill);
  }
}
