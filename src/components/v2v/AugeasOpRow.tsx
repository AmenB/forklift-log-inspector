/**
 * Augeas operation row — shows a single augeas get/set/rm/match.
 */
import { LineLink } from './LineLink';
import type { FileOp } from './fileTreeTypes';

const AUGEAS_OP_STYLES: Record<string, string> = {
  get: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
  set: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400',
  rm: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
  match: 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400',
  clear: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
  ls: 'bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400',
};

export function AugeasOpRow({ op }: { op: FileOp }) {
  const opLabel = (op.augOp || 'get').toUpperCase();
  const style = AUGEAS_OP_STYLES[op.augOp || 'get'] || AUGEAS_OP_STYLES.get;

  // Truncate long values for display
  const value = op.augValue || '';
  const displayValue = value.length > 120 ? value.slice(0, 117) + '...' : value;

  return (
    <div className="flex items-baseline gap-2 px-3 py-1 hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
      <span className={`text-[8px] px-1.5 py-0 rounded font-bold flex-shrink-0 ${style}`}>
        {opLabel}
      </span>
      {op.augKey && (
        <span className="font-mono text-slate-500 dark:text-gray-400 flex-shrink-0">
          {op.augKey}
        </span>
      )}
      {value && (op.augOp === 'get' || op.augOp === 'set') && (
        <>
          <span className="text-slate-400 dark:text-gray-600 flex-shrink-0">=</span>
          <span
            className="font-mono text-slate-700 dark:text-gray-300 truncate"
            title={value}
          >
            {displayValue}
          </span>
        </>
      )}
      {(op.augOp === 'match' || op.augOp === 'ls') && value && (
        <>
          <span className="text-slate-400 dark:text-gray-600 flex-shrink-0">&rarr;</span>
          <span className="font-mono text-slate-500 dark:text-gray-400 truncate" title={value}>
            {displayValue}
          </span>
        </>
      )}
      {op.augOp === 'clear' && (
        <span className="text-slate-400 dark:text-gray-500 italic text-[10px]">(cleared)</span>
      )}
      <span className="flex-shrink-0 ml-auto">
        <LineLink line={op.lineNumber} />
      </span>
    </div>
  );
}
