/**
 * Types shared between platform client components.
 */

export interface ProvisioningStep {
  step: string;
  label: string;
  status: "in_progress" | "done" | "error";
  detail?: string;
}
