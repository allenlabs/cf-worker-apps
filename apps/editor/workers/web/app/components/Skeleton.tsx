// Lightweight shimmer skeleton blocks used in place of bare "Loading…" text so
// loading states feel fast and on-brand (Notion-style). The shimmer + dark
// variant live in app.css (`.ae-skeleton`), and both honour
// prefers-reduced-motion. Purely presentational — no state, no deps.

interface SkeletonProps {
  className?: string;
  /** Inline width override (e.g. '60%') when a class isn't convenient. */
  width?: string;
  /** Inline height override (e.g. '1.25rem'). */
  height?: string;
}

/** A single shimmer block. */
export function Skeleton({ className = '', width, height }: SkeletonProps) {
  return (
    <div
      className={`ae-skeleton ${className}`}
      style={{ width, height }}
      aria-hidden="true"
      data-testid="skeleton"
    />
  );
}

/** Page editor placeholder: a title bar + a few paragraph lines. */
export function PageSkeleton() {
  return (
    <div className="space-y-3 py-2" data-testid="page-skeleton" aria-busy="true">
      <Skeleton className="h-8 w-2/3" />
      <div className="space-y-2 pt-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    </div>
  );
}

/** Database placeholder: a header row + several body rows. */
export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 py-2" data-testid="table-skeleton" aria-busy="true">
      <Skeleton className="h-6 w-40" />
      <div className="space-y-1.5 pt-1">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-full" />
        ))}
      </div>
    </div>
  );
}
