import { readFileSync } from "node:fs";

/** Count newlines in a file. Fast: reads raw buffer, counts 0x0A bytes. */
export function countFileLines(path: string): number {
  try {
    const buf = readFileSync(path);
    let count = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) count++;
    }
    return count;
  } catch {
    return 0;
  }
}
