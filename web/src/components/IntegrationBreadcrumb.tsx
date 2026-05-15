interface IntegrationBreadcrumbProps {
  current: string;
}

export function IntegrationBreadcrumb({ current }: IntegrationBreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1.5 text-xs font-medium text-cc-muted">
      <a href="#/integrations" className="transition-colors hover:text-cc-fg">
        Integrations
      </a>
      <span aria-hidden="true" className="text-cc-muted/70">
        &gt;
      </span>
      <span className="text-cc-fg">{current}</span>
    </nav>
  );
}
