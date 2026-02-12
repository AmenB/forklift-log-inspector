import { useState, useMemo } from 'react';
import type { V2VGuestInfo, V2VSourceVM, V2VInstalledApp } from '../../types/v2v';
import { formatMemory } from '../../utils/format';
import { InfoTag } from './shared';
import { ExpandArrow } from '../common';

interface GuestInfoPanelProps {
  info?: V2VGuestInfo | null;
  sourceVM?: V2VSourceVM | null;
  apps?: V2VInstalledApp[];
}

/**
 * Convert a CPE string like `cpe:2.3:o:amazon:amazon_linux:2023` into a
 * human-readable product name like `Amazon Linux 2023`.
 * Returns the original string if it's not a CPE.
 */
function formatProductName(raw: string): string {
  if (!raw.startsWith('cpe:')) return raw;
  // CPE 2.3 format: cpe:2.3:part:vendor:product:version:...
  const parts = raw.split(':');
  if (parts.length >= 6) {
    const product = parts[4].replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const ver = parts[5] && parts[5] !== '*' ? ` ${parts[5]}` : '';
    return `${product}${ver}`;
  }
  return raw;
}

export function GuestInfoPanel({ info, sourceVM, apps = [] }: GuestInfoPanelProps) {
  const hasInfo = !!info;
  const isWindows = info?.type === 'windows';
  const [appFilter, setAppFilter] = useState('');

  const filteredApps = useMemo(() => {
    if (!appFilter) return apps;
    const lower = appFilter.toLowerCase();
    return apps.filter(
      (app) =>
        app.displayName.toLowerCase().includes(lower) ||
        app.name.toLowerCase().includes(lower) ||
        app.publisher.toLowerCase().includes(lower) ||
        app.version.toLowerCase().includes(lower),
    );
  }, [apps, appFilter]);

  // Build display name from whatever data we have
  const displayName = info
    ? formatProductName(info.productName) || info.distro || info.type
    : sourceVM?.name || 'Unknown';

  const version = info
    ? info.minorVersion
      ? `${info.majorVersion}.${info.minorVersion}`
      : `${info.majorVersion}`
    : null;

  return (
    <div className="space-y-4">
      {/* OS / VM Summary */}
      <div className="flex items-center gap-3">
        <span className="text-2xl">
          {hasInfo ? (isWindows ? '🪟' : '🐧') : '🖥'}
        </span>
        <div>
          <h4 className="text-sm font-semibold text-slate-800 dark:text-gray-200">
            {displayName}
            {sourceVM?.name && hasInfo && (
              <span className="text-slate-400 dark:text-gray-500 font-normal ml-2">
                ({sourceVM.name})
              </span>
            )}
          </h4>
          {info && (
            <p className="text-xs text-slate-500 dark:text-gray-400">
              {info.productVariant && `${info.productVariant} · `}
              {info.arch} · v{version}
              {info.osinfo && ` · ${info.osinfo}`}
            </p>
          )}
        </div>
      </div>

      {/* Source VM tags (vCPUs, Memory, Firmware) */}
      {sourceVM && (sourceVM.vcpus !== undefined || sourceVM.memoryKB !== undefined || sourceVM.firmware) && (
        <div className="flex flex-wrap gap-2">
          {sourceVM.vcpus !== undefined && (
            <InfoTag label="vCPUs" value={String(sourceVM.vcpus)} />
          )}
          {sourceVM.memoryKB !== undefined && (
            <InfoTag label="Memory" value={formatMemory(sourceVM.memoryKB)} />
          )}
          {sourceVM.firmware && (
            <InfoTag label="Firmware" value={sourceVM.firmware.toUpperCase()} />
          )}
        </div>
      )}

      {/* Details Grid — only when we have deep inspection */}
      {info && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2">
          <InfoRow label="Root Device" value={info.root} mono />
          <InfoRow label="Type" value={info.type} />
          <InfoRow label="Distro" value={info.distro} />
          <InfoRow label="Architecture" value={info.arch} />
          {version && <InfoRow label="Version" value={version} />}
          {info.hostname && <InfoRow label="Hostname" value={info.hostname} mono />}
          {info.buildId && <InfoRow label="Build ID" value={info.buildId} />}
          {info.packageFormat && info.packageFormat !== 'unknown' && (
            <InfoRow label="Package Format" value={info.packageFormat} />
          )}
          {info.packageManagement && info.packageManagement !== 'unknown' && (
            <InfoRow label="Package Mgmt" value={info.packageManagement} />
          )}
        </div>
      )}

      {/* Windows-specific */}
      {info && isWindows && (info.windowsSystemroot || info.windowsCurrentControlSet) && (
        <div>
          <h5 className="text-[11px] font-semibold text-slate-600 dark:text-gray-400 uppercase tracking-wider mb-1.5">
            Windows Details
          </h5>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2">
            {info.windowsSystemroot && (
              <InfoRow label="System Root" value={info.windowsSystemroot} mono />
            )}
            {info.windowsCurrentControlSet && (
              <InfoRow label="Control Set" value={info.windowsCurrentControlSet} mono />
            )}
            {info.windowsSoftwareHive && (
              <InfoRow label="Software Hive" value={info.windowsSoftwareHive} mono />
            )}
            {info.windowsSystemHive && (
              <InfoRow label="System Hive" value={info.windowsSystemHive} mono />
            )}
          </div>
        </div>
      )}

      {/* Drive Mappings (Windows) */}
      {info && info.driveMappings.length > 0 && (
        <div>
          <h5 className="text-[11px] font-semibold text-slate-600 dark:text-gray-400 uppercase tracking-wider mb-1.5">
            Drive Mappings
          </h5>
          <div className="flex flex-wrap gap-2">
            {info.driveMappings.map((dm) => (
              <span
                key={dm.letter}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-100 dark:bg-slate-800 text-xs"
              >
                <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                  {dm.letter}:
                </span>
                <span className="text-slate-500 dark:text-gray-500">&rarr;</span>
                <span className="font-mono text-slate-700 dark:text-gray-300">{dm.device}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Fstab (Linux) */}
      {info && info.fstab.length > 0 && (
        <div>
          <h5 className="text-[11px] font-semibold text-slate-600 dark:text-gray-400 uppercase tracking-wider mb-1.5">
            Filesystem Table
          </h5>
          <div className="flex flex-wrap gap-2">
            {info.fstab.map((entry) => (
              <span
                key={`${entry.device}::${entry.mountpoint}`}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-100 dark:bg-slate-800 text-xs"
              >
                <span className="font-mono text-slate-700 dark:text-gray-300">{entry.device}</span>
                <span className="text-slate-500 dark:text-gray-500">&rarr;</span>
                <span className="font-semibold text-indigo-600 dark:text-indigo-400 font-mono">
                  {entry.mountpoint}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Block Device Info (blkid) */}
      {info && info.blkid && info.blkid.length > 0 && (
        <BlkidSection entries={info.blkid} />
      )}

      {/* Installed Applications — collapsible, hidden by default */}
      {apps.length > 0 && (
        <InstalledAppsSection
          apps={apps}
          filteredApps={filteredApps}
          appFilter={appFilter}
          onFilterChange={setAppFilter}
        />
      )}
    </div>
  );
}

function InstalledAppsSection({
  apps,
  filteredApps,
  appFilter,
  onFilterChange,
}: {
  apps: V2VInstalledApp[];
  filteredApps: V2VInstalledApp[];
  appFilter: string;
  onFilterChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
      >
        <h5 className="text-[11px] font-semibold text-slate-600 dark:text-gray-400 uppercase tracking-wider">
          Installed Applications ({apps.length})
        </h5>
        <svg
          className={`w-4 h-4 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div>
          <div className="px-3 py-2 border-t border-slate-100 dark:border-slate-800">
            <input
              type="text"
              placeholder="Filter applications..."
              value={appFilter}
              onChange={(e) => onFilterChange(e.target.value)}
              className="w-full max-w-xs px-3 py-1 text-xs border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-gray-100 placeholder:text-slate-400"
            />
          </div>

          <div className="max-h-[400px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-gray-400 text-left sticky top-0">
                  <th className="px-3 py-2 font-medium">Application</th>
                  <th className="px-3 py-2 font-medium">Version</th>
                  <th className="px-3 py-2 font-medium hidden md:table-cell">Publisher</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredApps.map((app, idx) => (
                  <AppRow key={idx} app={app} />
                ))}
                {filteredApps.length === 0 && (
                  <tr>
                    <td
                      colSpan={3}
                      className="px-3 py-4 text-center text-slate-400 dark:text-gray-500 italic"
                    >
                      {appFilter ? 'No matching applications' : 'No applications detected'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function AppRow({ app }: { app: V2VInstalledApp }) {
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

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] text-slate-400 dark:text-gray-500 uppercase tracking-wider">
        {label}
      </span>
      <span
        className={`text-xs text-slate-700 dark:text-gray-300 ${mono ? 'font-mono' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}

function BlkidSection({ entries }: { entries: import('../../types/v2v').V2VBlkidEntry[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-gray-400 hover:text-slate-800 dark:hover:text-gray-200 transition-colors uppercase tracking-wider font-semibold mb-1.5"
      >
        <ExpandArrow expanded={open} className="text-[9px]" />
        Block Devices (blkid)
        <span className="text-[10px] font-normal text-slate-400 dark:text-gray-500">
          ({entries.length})
        </span>
      </button>
      {open && (
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
                <th className="px-3 py-1 font-medium">Device</th>
                <th className="px-3 py-1 font-medium">Type</th>
                <th className="px-3 py-1 font-medium">Label</th>
                <th className="px-3 py-1 font-medium">UUID</th>
                <th className="px-3 py-1 font-medium">PARTUUID</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.device} className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="px-3 py-1.5 font-mono text-slate-700 dark:text-gray-300">
                    {e.device}
                  </td>
                  <td className="px-3 py-1.5">
                    {e.type ? (
                      <span className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${
                        e.type === 'ntfs' ? 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300'
                        : e.type === 'vfat' || e.type === 'fat32' ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300'
                        : e.type === 'ext4' || e.type === 'ext3' || e.type === 'ext2' ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                        : e.type === 'xfs' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                        : e.type === 'swap' ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-gray-300'
                      }`}>
                        {e.type}
                      </span>
                    ) : (
                      <span className="text-slate-300 dark:text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-slate-500 dark:text-gray-400">
                    {e.partLabel || e.label || '—'}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-slate-500 dark:text-gray-400 truncate max-w-[180px]" title={e.uuid}>
                    {e.uuid || '—'}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-slate-500 dark:text-gray-400 truncate max-w-[180px]" title={e.partUuid}>
                    {e.partUuid || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
