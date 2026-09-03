import test from "node:test";
import { assertRuntimeV3Contraction } from "./runtime-v3-contraction-guard.mjs";

test("production routes, imports, contracts, schema exports, and grants are v3-only", () => {
  assertRuntimeV3Contraction();
});
