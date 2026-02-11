/**
 * Reusable collapsible card with chevron animation, matching the pattern
 * used across v2v components (CycleLogsModal, PhaseLogsModal, SELinuxView, etc.).
 */
import { useState, useId } from 'react';

interface CollapsibleCardProps {
  title: React.ReactNode;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  badge?: React.ReactNode;
  className?: string;
}

const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
  <svg
    className={`w-4 h-4 text-cyan-600 dark:text-cyan-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    aria-hidden
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M9 5l7 7-7 7"
    />
  </svg>
);

export function CollapsibleCard({
  title,
  children,
  defaultExpanded = false,
  badge,
  className = '',
}: CollapsibleCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const contentId = useId();
  const headerId = useId();

  return (
    <div
      className={`border border-cyan-200 dark:border-cyan-800 rounded-lg overflow-hidden ${className}`}
    >
      <button
        type="button"
        id={headerId}
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full px-4 py-3 bg-cyan-50 dark:bg-cyan-900/30 flex items-center justify-between hover:bg-cyan-100 dark:hover:bg-cyan-900/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <ChevronIcon expanded={expanded} />
          <span className="font-semibold text-cyan-700 dark:text-cyan-300">
            {title}
          </span>
          {badge && (
            <span className="flex items-center gap-2">{badge}</span>
          )}
        </div>
      </button>

      {expanded && (
        <div
          id={contentId}
          role="region"
          aria-labelledby={headerId}
          className="p-3 space-y-2 bg-white dark:bg-slate-800 border-t border-slate-200 dark:border-slate-700"
        >
          {children}
        </div>
      )}
    </div>
  );
}
