/**
 * Small reusable UI primitives shared across v2v panels.
 */
import { useState } from 'react';
import type { V2VFileCopy, V2VInstalledApp } from '../../types/v2v';
import { ExpandArrow } from '../common';

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

/** Color badge used across v2v views. Use variant="pill" for rounded-full summary style. */
export type BadgeColor = 'green' | 'red' | 'blue' | 'slate' | 'purple' | 'amber';

const BADGE_COLORS: Record<BadgeColor, string> = {
  green: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
  red: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300',
  blue: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
  slate: 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-gray-300',
  purple: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
  amber: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
};

export function Badge({
  children,
  color,
  variant = 'default',
}: {
  children: React.ReactNode;
  color: BadgeColor;
  variant?: 'default' | 'pill';
}) {
  const cls =
    variant === 'pill'
      ? `inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${BADGE_COLORS[color]}`
      : `inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium ${BADGE_COLORS[color]}`;
  return <span className={cls}>{children}</span>;
}

/** Filesystem-type badge with color coding by fs type. */
export function FsTypeBadge({ fsType }: { fsType: string | undefined }) {
  if (!fsType || fsType === 'unknown') {
    return <span className="text-[10px] text-slate-400 dark:text-gray-500 italic">unknown</span>;
  }
  const colorClass = fsTypeBadgeClass(fsType);
  return (
    <span className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${colorClass}`}>
      {fsType}
    </span>
  );
}

/** Returns a Tailwind color class for the given filesystem type. */
export function fsTypeBadgeClass(fsType: string): string {
  switch (fsType) {
    case 'xfs':
      return 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300';
    case 'ext4':
    case 'ext3':
    case 'ext2':
      return 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300';
    case 'vfat':
    case 'fat16':
    case 'fat32':
      return 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300';
    case 'ntfs':
      return 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300';
    case 'swap':
      return 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300';
    case 'LVM2_member':
      return 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300';
    default:
      return 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-gray-300';
  }
}

/** Expandable table row for an installed application. Used by GuestInfoPanel & RegistryAppsPanel. */
export function AppRow({ app }: { app: V2VInstalledApp }) {
  const [expanded, setExpanded] = useState(false);
  const displayName = app.displayName || app.name;
  const hasDetails = app.installPath || app.description || app.arch;

  return (
    <>
      <tr
        onClick={hasDetails ? () => setExpanded(!expanded) : undefined}
        className={`${
          hasDetails ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50' : ''
        } transition-colors`}
      >
        <td className="px-3 py-1.5 text-slate-800 dark:text-gray-200">
          <div className="flex items-center gap-1.5">
            {hasDetails && (
              <ExpandArrow expanded={expanded} className="text-[8px] text-slate-400 flex-shrink-0" />
            )}
            <span className="truncate">{displayName}</span>
          </div>
        </td>
        <td className="px-3 py-1.5 font-mono text-slate-600 dark:text-gray-400">
          {app.version}
        </td>
        <td className="px-3 py-1.5 text-slate-500 dark:text-gray-500 hidden md:table-cell truncate max-w-[200px]">
          {app.publisher}
        </td>
      </tr>
      {expanded && hasDetails && (
        <tr>
          <td colSpan={3} className="px-3 py-2 bg-slate-50 dark:bg-slate-800/30">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] pl-4">
              {app.installPath && (
                <span>
                  <span className="text-slate-400 dark:text-gray-500">Path: </span>
                  <span className="font-mono text-slate-600 dark:text-gray-400">
                    {app.installPath}
                  </span>
                </span>
              )}
              {app.arch && (
                <span>
                  <span className="text-slate-400 dark:text-gray-500">Arch: </span>
                  <span className="text-slate-600 dark:text-gray-400">{app.arch}</span>
                </span>
              )}
              {app.description && (
                <span>
                  <span className="text-slate-400 dark:text-gray-500">Description: </span>
                  <span className="text-slate-600 dark:text-gray-400">{app.description}</span>
                </span>
              )}
              {app.name && app.name !== app.displayName && (
                <span>
                  <span className="text-slate-400 dark:text-gray-500">ID: </span>
                  <span className="font-mono text-slate-500 dark:text-gray-500">{app.name}</span>
                </span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
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

/** Highlight all occurrences of `query` within `text` using a <mark> element. */
export function highlightSearch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let lastIdx = 0;

  while (true) {
    const idx = lower.indexOf(lowerQuery, lastIdx);
    if (idx === -1) break;
    if (idx > lastIdx) parts.push(text.slice(lastIdx, idx));
    parts.push(
      <mark key={idx} className="bg-yellow-300 dark:bg-yellow-700 text-inherit rounded-sm px-0.5">
        {text.slice(idx, idx + query.length)}
      </mark>,
    );
    lastIdx = idx + query.length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length > 0 ? <>{parts}</> : text;
}
