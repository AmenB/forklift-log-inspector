import { useMemo } from 'react';
import type { V2VError } from '../../types/v2v';
import { LineLink } from './LineLink';

interface V2VErrorsPanelProps {
  errors: V2VError[];
}

export function V2VErrorsPanel({ errors }: V2VErrorsPanelProps) {

  const grouped = useMemo(() => {
    const errs = errors.filter((e) => e.level === 'error');
    const warns = errors.filter((e) => e.level === 'warning');
    return { errors: errs, warnings: warns };
  }, [errors]);

  // Deduplicate by message, keeping the latest (highest lineNumber) occurrence,
  // and sort newest-first so the most recent errors appear at the top.
  const deduped = useMemo(() => {
    const dedupe = (items: V2VError[]) => {
      const map = new Map<string, { error: V2VError; count: number }>();
      for (const item of items) {
        const key = item.message.slice(0, 200);
        const existing = map.get(key);
        if (existing) {
          existing.count++;
          // Keep the latest occurrence
          if (item.lineNumber > existing.error.lineNumber) {
            existing.error = item;
          }
        } else {
          map.set(key, { error: item, count: 1 });
        }
      }
      return [...map.values()].sort((a, b) => {
        // Command-level errors first, then by line number (newest first)
        const pa = sourcePriority(a.error.source);
        const pb = sourcePriority(b.error.source);
        if (pa !== pb) return pa - pb;
        return b.error.lineNumber - a.error.lineNumber;
      });
    };
    return {
      errors: dedupe(grouped.errors),
      warnings: dedupe(grouped.warnings),
    };
  }, [grouped]);

  if (errors.length === 0) {
    return (
      <p className="text-sm text-green-600 dark:text-green-400">
        No errors or warnings found.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {/* Errors */}
      {deduped.errors.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-red-600 dark:text-red-400 mb-2 flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
            Errors ({grouped.errors.length})
          </h4>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {deduped.errors.map(({ error, count }, idx) => (
              <ErrorRow
                key={idx}
                error={error}
                count={count}
              />
            ))}
          </div>
        </div>
      )}

      {/* Warnings */}
      {deduped.warnings.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-orange-600 dark:text-orange-400 mb-2 flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            Warnings ({grouped.warnings.length})
          </h4>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {deduped.warnings.map(({ error, count }, idx) => (
              <ErrorRow
                key={idx}
                error={error}
                count={count}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Lower number = higher priority (shown first) */
function sourcePriority(source: string): number {
  if (/^virt-v2v/.test(source) || source === 'virt-customize') return 0;
  if (source === 'nbdkit') return 1;
  if (source === 'libguestfs') return 2;
  if (source === 'guestfsd') return 3;
  return 4;
}

function ErrorRow({
  error,
  count,
}: {
  error: V2VError;
  count: number;
}) {
  const isError = error.level === 'error';

  return (
    <div
      className={`
        flex items-start gap-2 text-xs px-3 py-2 rounded transition-colors
        ${isError
          ? 'bg-red-50 dark:bg-red-900/20'
          : 'bg-orange-50 dark:bg-orange-900/20'
        }
      `}
    >
      {/* Source badge */}
      <span
        className={`
          px-1.5 py-0.5 rounded text-[9px] font-medium flex-shrink-0
          ${isError
            ? 'bg-red-200 dark:bg-red-800 text-red-800 dark:text-red-200'
            : 'bg-orange-200 dark:bg-orange-800 text-orange-800 dark:text-orange-200'
          }
        `}
      >
        {error.source}
      </span>

      {/* Message */}
      <span
        className={`flex-1 font-mono text-[11px] break-all ${
          isError
            ? 'text-red-700 dark:text-red-300'
            : 'text-orange-700 dark:text-orange-300'
        }`}
      >
        {error.message.length > 300 ? error.message.slice(0, 297) + '...' : error.message}
      </span>

      {/* Count badge */}
      {count > 1 && (
        <span
          className={`
            px-1.5 py-0.5 rounded-full text-[10px] font-bold flex-shrink-0
            ${isError
              ? 'bg-red-500 text-white'
              : 'bg-orange-500 text-white'
            }
          `}
        >
          {count}x
        </span>
      )}

      {/* Line link */}
      <span className="flex-shrink-0">
        <LineLink line={error.lineNumber} />
      </span>
    </div>
  );
}
