interface StepDef {
  label: string;
}

interface WizardStepIndicatorProps {
  steps: StepDef[];
  currentStep: number;
  completedSteps: Set<number>;
}

export function WizardStepIndicator({ steps, currentStep, completedSteps }: WizardStepIndicatorProps) {
  return (
    <nav aria-label="Setup progress" className="flex items-center gap-0 w-full mb-8">
      {steps.map((step, i) => {
        const stepNum = i + 1;
        const isCompleted = completedSteps.has(stepNum);
        const isCurrent = stepNum === currentStep;
        const isPending = !isCompleted && !isCurrent;

        return (
          <div key={stepNum} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-semibold border-2 transition-colors ${
                  isCompleted
                    ? "bg-cc-success/15 border-cc-success text-cc-success"
                    : isCurrent
                      ? "bg-cc-primary/15 border-cc-primary text-cc-primary"
                      : "bg-cc-hover border-cc-border text-cc-muted"
                }`}
                aria-current={isCurrent ? "step" : undefined}
                aria-label={`Step ${stepNum}: ${step.label}${isCompleted ? " (completed)" : isCurrent ? " (current)" : ""}`}
              >
                {isCompleted ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  stepNum
                )}
              </div>
              <span
                className={`text-[10px] whitespace-nowrap ${
                  isPending ? "text-cc-muted" : isCurrent ? "text-cc-primary font-medium" : "text-cc-success"
                }`}
              >
                {step.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={`flex-1 h-0.5 mx-2 mt-[-18px] rounded ${
                  completedSteps.has(stepNum) ? "bg-cc-success/40" : "bg-cc-border"
                }`}
              />
            )}
          </div>
        );
      })}
    </nav>
  );
}
