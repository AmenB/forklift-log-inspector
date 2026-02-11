/**
 * Small reusable UI primitives shared across v2v panels.
 */
import type { V2VFileCopy } from '../../types/v2v';

/** Uppercase section heading used throughout structured views. */
export function SectionHeader({ title, count, badge }: { title: string; count?: number; badge?: string }) {
  const heading = (
    <h4 className={`text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-gray-400${badge ? '' : ' mb-2'}`}>
      {title}
      {count != null && (
        <span className="ml-1.5 text-[10px] font-normal text-slate-400 dark:text-gray-500">({count})</span>
      )}
    </h4>
  );
  if (badge) {
    return (
      <div className="flex items-center gap-2 mb-2">
        {heading}
        <span className="px-1.5 py-0 rounded-full bg-slate-200 dark:bg-slate-700 text-[10px] text-slate-600 dark:text-gray-300">
          {badge}
        </span>
      </div>
    );
  }
  return heading;
}

/** Compact label:value tag (e.g. "vCPUs: 4"). */
export function InfoTag({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-100 dark:bg-slate-800 text-xs">
      <span className="text-slate-500 dark:text-gray-400">{label}:</span>
      <span className="font-medium text-slate-700 dark:text-gray-200">{value}</span>
    </span>
  );
}

/** Colored badge indicating the origin of a file copy operation. */
export function OriginBadge({ origin }: { origin: V2VFileCopy['origin'] }) {
  const classes: Record<V2VFileCopy['origin'], string> = {
    virtio_win: 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400 border-purple-200 dark:border-purple-800',
    'virt-tools': 'bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400 border-orange-200 dark:border-orange-800',
    script: 'bg-teal-50 dark:bg-teal-900/20 text-teal-700 dark:text-teal-400 border-teal-200 dark:border-teal-800',
    guest: 'bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-400 border-sky-200 dark:border-sky-800',
  };
  const labels: Record<V2VFileCopy['origin'], string> = {
    virtio_win: 'VirtIO',
    'virt-tools': 'Tool',
    script: 'Script',
    guest: 'Guest',
  };
  return (
    <span className={`inline-block px-1 py-0 rounded text-[9px] font-semibold border leading-tight ${classes[origin]}`}>
      {labels[origin]}
    </span>
  );
}
