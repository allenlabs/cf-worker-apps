export function StatusBadge({ name, color, closed }: { name: string; color: string; closed?: boolean }) {
  return (
    <span
      className={`badge ${closed ? 'opacity-75' : ''}`}
      style={{ backgroundColor: color, color: '#1f3a47' }}
      title={name}
    >
      {name}
    </span>
  );
}

export function PriorityBadge({ name, color }: { name: string; color: string }) {
  return (
    <span className="badge" style={{ backgroundColor: color, color: '#1f3a47' }}>{name}</span>
  );
}

export function TrackerBadge({ name, color }: { name: string; color: string }) {
  return (
    <span className="badge" style={{ backgroundColor: color, color: 'white' }}>{name}</span>
  );
}

export function LabelChip({ name, color }: { name: string; color: string }) {
  return (
    <span
      className="badge inline-flex items-center gap-1"
      style={{ backgroundColor: `${color}22`, color: '#1f2937' }}
      title={name}
    >
      <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
      {name}
    </span>
  );
}

export function ProgressBar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="h-2 w-full bg-gray-200 rounded overflow-hidden">
      <div className="h-full bg-redmine-500" style={{ width: `${v}%` }} />
    </div>
  );
}
