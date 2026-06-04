/**
 * Barrel for the console component library. Feature pages import named
 * components from here, e.g. `import { Card, Button, PlanDiff } from
 * "../app/components"`.
 */

export { AppLayout } from "./AppLayout";
export type { AppLayoutProps } from "./AppLayout";

export { PageHeader } from "./PageHeader";
export type { PageHeaderProps } from "./PageHeader";

export { Card } from "./Card";
export type { CardProps } from "./Card";

export { Button } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./Button";

export { TextField } from "./TextField";
export type { TextFieldProps } from "./TextField";

export { SelectField } from "./SelectField";
export type { SelectFieldProps, SelectOption } from "./SelectField";

export { Toggle } from "./Toggle";
export type { ToggleProps } from "./Toggle";

export { Spinner } from "./Spinner";
export type { SpinnerProps } from "./Spinner";

export { EmptyState } from "./EmptyState";
export type { EmptyStateProps } from "./EmptyState";

export { ErrorBanner } from "./ErrorBanner";
export type { ErrorBannerProps } from "./ErrorBanner";

export { ConfirmDialog } from "./ConfirmDialog";
export type { ConfirmDialogProps } from "./ConfirmDialog";

export { CodeBlock } from "./CodeBlock";
export type { CodeBlockProps } from "./CodeBlock";

export { Badge } from "./Badge";
export type { BadgeProps, BadgeTone } from "./Badge";

export { HealthBadge } from "./HealthBadge";
export type { HealthBadgeProps } from "./HealthBadge";

export { PlanDiff } from "./PlanDiff";
export type { PlanDiffProps } from "./PlanDiff";

export { OperationProgress } from "./OperationProgress";
export type { OperationProgressProps } from "./OperationProgress";

export {
  AgentForm,
  emptyAgentInput,
  validateAgentInput,
  AGENT_ID_PATTERN,
} from "./AgentForm";
export type { AgentFormProps, AgentFormErrors } from "./AgentForm";
