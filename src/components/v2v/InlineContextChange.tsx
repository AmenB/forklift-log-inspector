/**
 * SELinux relabel context change — inline display for relabelled files.
 */

export function InlineContextChange({ fromContext, toContext }: { fromContext: string; toContext: string }) {
  const isNew = fromContext === '<no context>';

  // Detect what changed
  const fromParts = fromContext.split(':');
  const toParts = toContext.split(':');
  const userChanged = !isNew && fromParts[0] !== toParts[0];
  const typeChanged = !isNew && (fromParts[2] || '') !== (toParts[2] || '');

  // Pick color based on change type
  const toColor = isNew
    ? 'text-purple-600 dark:text-purple-400'
    : userChanged
      ? 'text-blue-600 dark:text-blue-400'
      : typeChanged
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-slate-500 dark:text-gray-400';

  return (
    <span className="inline-flex items-center gap-1 ml-1 text-[9px] font-mono overflow-hidden">
      {isNew ? (
        <span className={toColor}>{toContext}</span>
      ) : (
        <>
          <span className="text-slate-400 dark:text-gray-600 line-through truncate max-w-[180px]" title={fromContext}>
            {fromContext}
          </span>
          <span className="text-slate-300 dark:text-gray-600 flex-shrink-0">{'\u2192'}</span>
          <span className={`${toColor} truncate max-w-[180px]`} title={toContext}>
            {toContext}
          </span>
        </>
      )}
    </span>
  );
}
