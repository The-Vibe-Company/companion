import type { CompanionTriggerProviderAccount } from "@companion/contracts";

/** Shared trigger contracts used by the Runtime v3 Companion surface. */
export type {
  CompanionTrigger,
  CompanionTriggerMode,
  CompanionTriggerProvider,
  CompanionTriggerRegistrationStatus,
  CreateCompanionTriggerInput,
  UpdateCompanionTriggerInput,
} from "@companion/contracts";

/** Credential-free member authority shared by every Companion without an attachment step. */
export type CompanionTriggerAccountOption = CompanionTriggerProviderAccount;
