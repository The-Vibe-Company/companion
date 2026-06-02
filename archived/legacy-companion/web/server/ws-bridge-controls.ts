import type { Session } from "./ws-bridge-types.js";

export function handleSetAiValidation(
  session: Session,
  msg: {
    aiValidationEnabled?: boolean | null;
    aiValidationAutoApprove?: boolean | null;
    aiValidationAutoDeny?: boolean | null;
  },
): void {
  if (msg.aiValidationEnabled !== undefined) {
    session.state.aiValidationEnabled = msg.aiValidationEnabled;
  }
  if (msg.aiValidationAutoApprove !== undefined) {
    session.state.aiValidationAutoApprove = msg.aiValidationAutoApprove;
  }
  if (msg.aiValidationAutoDeny !== undefined) {
    session.state.aiValidationAutoDeny = msg.aiValidationAutoDeny;
  }
}
