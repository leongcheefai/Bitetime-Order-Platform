export function Skeleton({ width = '100%', height = '1rem', radius = 'var(--radius-sm)', className = '' }:
  { width?: string; height?: string; radius?: string; className?: string }) {
  return <span className={`skeleton ${className}`} style={{ width, height, borderRadius: radius }} aria-hidden="true" />
}

export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span className="skeleton-text" aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height="0.85rem" width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </span>
  )
}

// Full-page placeholder shaped like the merchant dashboard (title + tab row +
// content) so a guarded/resolving page fills the viewport instead of showing a
// lonely spinner.
export function PageSkeleton() {
  return (
    <div className="form-wrap form-wrap--wide skeleton-page" aria-hidden="true">
      <div className="skeleton-page-head">
        <Skeleton width="44%" height="1.9rem" />
        <Skeleton width="26%" height="0.85rem" />
      </div>
      <div className="skeleton-page-tabs">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} width="84px" height="2.1rem" radius="var(--radius-pill)" />
        ))}
      </div>
      <div className="admin-panel skeleton-page-body">
        <SkeletonText lines={5} />
      </div>
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      {label && <span className="spinner-label">{label}</span>}
    </span>
  )
}
