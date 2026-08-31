import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeLogRecord, RuntimeProcessLog } from "@companion/companion-runtime";
import { captureRuntimeException, createSentryRuntimeProcessLog } from "./sentry";

type RuntimeLogCapture = (
  level: "info" | "warn" | "error",
  event: string,
  expurgatedRecord: string,
) => void;

function record(event: string, extra: Partial<RuntimeLogRecord> = {}): RuntimeLogRecord {
  return { ts: "2026-08-30T12:00:00.000Z", event, ...extra };
}

describe("runtime Sentry process log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the JSON sink, captures errors, and breadcrumbs operational warnings", () => {
    const base: RuntimeProcessLog = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    };
    const capture = vi.fn();
    const breadcrumb = vi.fn();
    const log = createSentryRuntimeProcessLog(base, capture, breadcrumb);
    const warning = record("lease.renew.failed");
    const failure = record("runtime.claim_loop.error");

    log.warn(warning);
    log.error(failure);

    expect(base.warn).toHaveBeenCalledWith(warning);
    expect(base.error).toHaveBeenCalledWith(failure);
    expect(breadcrumb).toHaveBeenCalledWith("warning", warning.event, JSON.stringify(warning));
    expect(capture).toHaveBeenCalledWith("error", failure.event, JSON.stringify(failure));
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("passes failed timing records to the Sentry breadcrumb boundary", () => {
    const base: RuntimeProcessLog = { error() {}, warn() {}, info() {} };
    const capture = vi.fn();
    const breadcrumb = vi.fn();
    const log = createSentryRuntimeProcessLog(base, capture, breadcrumb);
    const timing = record("runtime.box.provider_call", { ok: false });
    const success = record("runtime.box.provider_call", { ok: true });

    log.info(timing);
    log.info(success);

    expect(breadcrumb).toHaveBeenCalledWith("warning", timing.event, JSON.stringify(timing));
    expect(breadcrumb).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
  });

  it("expurgates records before sending them to the telemetry capture boundary", () => {
    const base: RuntimeProcessLog = { error() {}, warn() {}, info() {} };
    const capture = vi.fn<RuntimeLogCapture>();
    const log = createSentryRuntimeProcessLog(base, capture);

    log.error(record("runtime.provider.failed", {
      detail: "Authorization: Bearer super-secret-token",
    }));

    const captured = capture.mock.calls[0]?.[2];
    expect(captured).toContain("[redacted]");
    expect(captured).not.toContain("super-secret-token");
  });

  it("keeps the expurgated failure-site stack on captured exceptions", () => {
    const failure = new Error("provider failed token=super-secret-token");
    failure.stack = "Error: provider failed token=super-secret-token\n    at providerCall (/runtime/provider.ts:42:1)";

    const capture = vi.fn<(error: Error) => void>();
    captureRuntimeException(failure, "runtime.provider_call", capture);

    const captured = capture.mock.calls[0]?.[0];
    expect(captured).toBeDefined();
    if (!captured) throw new Error("Expected the exception capture dependency to be called");
    expect(captured.stack).toContain("providerCall");
    expect(captured.stack).not.toContain("super-secret-token");
  });
});
