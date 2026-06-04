/**
 * AgentForm tests: the form must (1) block submission and surface a field error
 * for an invalid agent id, and (2) call onSubmit with the assembled AgentInput
 * when every required field is valid. We drive it as a user would (typing into
 * labelled controls, clicking the submit button) and host it in a small stateful
 * wrapper so the controlled value updates the way the real parent provides it.
 */

import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentForm, emptyAgentInput, validateAgentInput } from "./AgentForm";
import type { AgentInput } from "../../api/types";

/** Hosts AgentForm with real controlled state so typing mutates the value. */
function Harness({
  onSubmit,
  initial,
  mode = "create",
}: {
  onSubmit: (v: AgentInput) => void;
  initial?: Partial<AgentInput>;
  mode?: "create" | "edit";
}) {
  const [value, setValue] = useState<AgentInput>({
    ...emptyAgentInput(),
    ...initial,
  });
  return (
    <AgentForm
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
      submitLabel="Create agent"
      mode={mode}
    />
  );
}

describe("validateAgentInput", () => {
  it("rejects ids that violate the contract", () => {
    const base = emptyAgentInput();
    expect(validateAgentInput({ ...base, id: "-bad" }, "create").id).toBeTruthy();
    expect(validateAgentInput({ ...base, id: "bad-" }, "create").id).toBeTruthy();
    expect(validateAgentInput({ ...base, id: "Bad" }, "create").id).toBeTruthy();
    expect(validateAgentInput({ ...base, id: "b a" }, "create").id).toBeTruthy();
    expect(validateAgentInput({ ...base, id: "" }, "create").id).toBeTruthy();
  });

  it("accepts valid ids and flags missing name/model + bad cpus", () => {
    const v: AgentInput = { ...emptyAgentInput(), id: "research-agent", cpus: 0 };
    const errs = validateAgentInput(v, "create");
    expect(errs.id).toBeUndefined();
    expect(errs.name).toBeTruthy();
    expect(errs.model).toBeTruthy();
    expect(errs.cpus).toBeTruthy();
  });

  it("ignores the id in edit mode (id is immutable)", () => {
    const v: AgentInput = {
      ...emptyAgentInput(),
      id: "",
      name: "x",
      model: "m",
    };
    expect(validateAgentInput(v, "edit").id).toBeUndefined();
  });
});

describe("AgentForm", () => {
  it("blocks submit and shows an error for an invalid id", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    // Fill name + model so the ONLY problem is the id.
    await user.type(screen.getByLabelText(/display name/i), "Research Agent");
    await user.type(screen.getByLabelText(/^model$/i), "anthropic/claude-3.5");
    await user.type(screen.getByLabelText(/agent id/i), "Bad_Id");

    await user.click(screen.getByRole("button", { name: /create agent/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    // The id field reports the contract violation and is marked invalid.
    const idField = screen.getByLabelText(/agent id/i);
    expect(idField).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByText(/lowercase letters, digits and hyphens/i),
    ).toBeInTheDocument();
  });

  it("blocks submit when required name/model are empty", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} initial={{ id: "valid-agent" }} />);

    await user.click(screen.getByRole("button", { name: /create agent/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/a display name is required/i)).toBeInTheDocument();
    expect(screen.getByText(/a model is required/i)).toBeInTheDocument();
  });

  it("calls onSubmit with the assembled input when valid", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/agent id/i), "research-agent");
    await user.type(screen.getByLabelText(/display name/i), "Research Agent");
    await user.type(screen.getByLabelText(/^model$/i), "anthropic/claude-3.5");

    await user.click(screen.getByRole("button", { name: /create agent/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0][0] as AgentInput;
    expect(submitted).toMatchObject({
      id: "research-agent",
      name: "Research Agent",
      model: "anthropic/claude-3.5",
      cpus: 1,
      // Console defaults are carried through.
      runtime: "fly.default",
      network: "tailscale.default",
      model_provider: "openrouter.default",
      lifecycle: "present",
      companion_soul_enabled: true,
    });
  });

  it("clears a field error once the user corrects it", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} initial={{ id: "valid-agent", model: "m" }} />);

    // Submit with empty name → error appears.
    await user.click(screen.getByRole("button", { name: /create agent/i }));
    expect(screen.getByText(/a display name is required/i)).toBeInTheDocument();

    // Typing into the name field clears its error eagerly.
    await user.type(screen.getByLabelText(/display name/i), "Now Named");
    expect(
      screen.queryByText(/a display name is required/i),
    ).not.toBeInTheDocument();
  });

  it("makes the id read-only in edit mode", () => {
    render(
      <Harness
        onSubmit={vi.fn()}
        mode="edit"
        initial={{ id: "locked-agent", name: "X", model: "m" }}
      />,
    );
    expect(screen.getByLabelText(/agent id/i)).toHaveAttribute("readonly");
  });
});
