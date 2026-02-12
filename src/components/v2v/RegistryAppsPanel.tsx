import { useState, useMemo } from 'react';
import type { V2VInstalledApp, V2VRegistryHiveAccess, V2VHivexValueOp } from '../../types/v2v';
import { LineLink } from './LineLink';

interface RegistryAppsPanelProps {
  apps: V2VInstalledApp[];
  hiveAccesses: V2VRegistryHiveAccess[];
}

/** Group structure: hive file → list of accesses with key paths, mode, and values */
export interface HiveGroup {
  hivePath: string;
  accesses: {
    keyPath: string;
    mode: 'read' | 'write';
    values: V2VHivexValueOp[];
    lineNumber: number;
  }[];
  readCount: number;
  writeCount: number;
  totalValues: number;
}

/** Group hive accesses by hive file path */
// eslint-disable-next-line react-refresh/only-export-components
export function groupHiveAccesses(hiveAccesses: V2VRegistryHiveAccess[]): HiveGroup[] {
  const map = new Map<string, HiveGroup>();
  for (const access of hiveAccesses) {
    let group = map.get(access.hivePath);
    if (!group) {
      group = { hivePath: access.hivePath, accesses: [], readCount: 0, writeCount: 0, totalValues: 0 };
      map.set(access.hivePath, group);
    }
    group.accesses.push({
      keyPath: access.keyPath,
      mode: access.mode,
      values: access.values,
      lineNumber: access.lineNumber,
    });
    if (access.mode === 'write') group.writeCount++;
    else group.readCount++;
    group.totalValues += access.values.length;
  }
  return [...map.values()].sort((a, b) => a.hivePath.localeCompare(b.hivePath));
}

export function RegistryAppsPanel({ apps, hiveAccesses }: RegistryAppsPanelProps) {
  const [filter, setFilter] = useState('');

  const hiveGroups = useMemo(() => groupHiveAccesses(hiveAccesses), [hiveAccesses]);

  // Filter apps
  const filtered = useMemo(() => {
    if (!filter) return apps;
    const lower = filter.toLowerCase();
    return apps.filter(
      (app) =>
        app.displayName.toLowerCase().includes(lower) ||
        app.name.toLowerCase().includes(lower) ||
        app.publisher.toLowerCase().includes(lower) ||
        app.version.toLowerCase().includes(lower),
    );
  }, [apps, filter]);

  return (
    <div className="space-y-4">
      {/* Registry hive accesses with key path details */}
      {hiveGroups.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-slate-500 dark:text-gray-400">
            {hiveGroups.length} registry hive{hiveGroups.length !== 1 ? 's' : ''} accessed
            ({hiveAccesses.length} key path{hiveAccesses.length !== 1 ? 's' : ''} traversed)
          </div>
          {hiveGroups.map((group) => (
            <HiveGroupCard key={group.hivePath} group={group} />
          ))}
        </div>
      )}

      {/* Installed Apps */}
      {apps.length > 0 && (
        <div>
          <div className="flex items-center gap-3 mb-2">
            <span className="text-xs text-slate-500 dark:text-gray-400">
              {apps.length} installed application{apps.length !== 1 ? 's' : ''}
            </span>
            <input
              type="text"
              placeholder="Filter applications..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="flex-1 max-w-xs px-3 py-1 text-xs border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-gray-100 placeholder:text-slate-400"
            />
          </div>

          <div className="max-h-[400px] overflow-y-auto border border-slate-200 dark:border-slate-700 rounded-lg">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-gray-400 text-left sticky top-0">
                  <th className="px-3 py-2 font-medium">Application</th>
                  <th className="px-3 py-2 font-medium">Version</th>
                  <th className="px-3 py-2 font-medium hidden md:table-cell">Publisher</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filtered.map((app, idx) => (
                  <AppRow key={idx} app={app} />
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td
                      colSpan={3}
                      className="px-3 py-4 text-center text-slate-400 dark:text-gray-500 italic"
                    >
                      {filter ? 'No matching applications' : 'No applications detected'}
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
              <span className="text-[8px] text-slate-400 flex-shrink-0">
                {expanded ? '▼' : '▶'}
              </span>
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

/** Card showing a single hive file and all the registry key paths traversed within it */
export function HiveGroupCard({ group }: { group: HiveGroup }) {
  const [expanded, setExpanded] = useState(false);
  // Get the hive file name for display (e.g. "SOFTWARE" from "/Windows/System32/config/SOFTWARE")
  const hiveFileName = group.hivePath.split('/').pop() || group.hivePath;

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-3 py-2 bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800/70 transition-colors text-left"
      >
        <span className="text-[9px] text-slate-400">{expanded ? '▼' : '▶'}</span>
        <span className="text-sm font-semibold text-slate-800 dark:text-gray-200">
          {hiveFileName}
        </span>
        <span className="text-[10px] font-mono text-slate-400 dark:text-gray-500 truncate flex-1 min-w-0">
          {group.hivePath}
        </span>
        <span className="flex items-center gap-2 flex-shrink-0 text-xs">
          {group.readCount > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              {group.readCount}
            </span>
          )}
          {group.writeCount > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
              {group.writeCount}
            </span>
          )}
          {group.accesses.length > 0 && (
            <LineLink line={group.accesses[0].lineNumber} />
          )}
        </span>
      </button>

      {/* Key paths */}
      {expanded && (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {group.accesses.map((access, idx) => (
            <KeyPathRow key={idx} access={access} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A single key path row with expandable values */
function KeyPathRow({ access }: {
  access: {
    keyPath: string;
    mode: 'read' | 'write';
    values: V2VHivexValueOp[];
    lineNumber: number;
  };
}) {
  const isWrite = access.mode === 'write';
  const hasValues = access.values.length > 0;
  const [showValues, setShowValues] = useState(false);

  return (
    <div className={isWrite ? 'bg-orange-50/40 dark:bg-orange-900/5' : ''}>
      <div
        onClick={hasValues ? () => setShowValues(!showValues) : undefined}
        className={`flex items-baseline gap-2 px-3 py-1.5 text-xs ${
          hasValues ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/30' : ''
        } transition-colors`}
      >
        {/* Expand toggle */}
        {hasValues ? (
          <span className="text-[8px] text-slate-400 flex-shrink-0 w-2">
            {showValues ? '▼' : '▶'}
          </span>
        ) : (
          <span className="w-2 flex-shrink-0" />
        )}

        {/* Read/Write badge */}
        {access.mode === 'read' ? (
          <span className="flex-shrink-0 w-11 text-center px-1 py-0.5 rounded text-[10px] font-medium bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400">
            READ
          </span>
        ) : (
          <span className="flex-shrink-0 w-11 text-center px-1 py-0.5 rounded text-[10px] font-medium bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400">
            WRITE
          </span>
        )}

        {/* Key path */}
        <span className={`font-mono truncate flex-1 min-w-0 ${
          isWrite
            ? 'text-orange-800 dark:text-orange-200'
            : 'text-slate-700 dark:text-gray-300'
        }`}>
          {access.keyPath || <span className="italic text-slate-400 dark:text-gray-500">(root)</span>}
        </span>

        {/* Value count badge */}
        {hasValues && (
          <span className={`flex-shrink-0 text-[10px] ${
            isWrite
              ? 'text-orange-500 dark:text-orange-400'
              : 'text-slate-400 dark:text-gray-500'
          }`}>
            {access.values.length} value{access.values.length !== 1 ? 's' : ''}
          </span>
        )}

        {/* Line link */}
        <span className="flex-shrink-0">
          <LineLink line={access.lineNumber} />
        </span>
      </div>

      {/* Expanded value details */}
      {showValues && hasValues && (
        <div className={`ml-6 mr-3 mb-2 border-l-2 ${
          isWrite
            ? 'border-orange-300 dark:border-orange-700'
            : 'border-slate-200 dark:border-slate-700'
        }`}>
          <div className="max-h-[300px] overflow-y-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-slate-400 dark:text-gray-500 text-left">
                  <th className="pl-3 pr-2 py-1 font-medium w-[140px] md:w-[180px]">Name</th>
                  <th className="px-2 py-1 font-medium">Value</th>
                  <th className="px-2 py-1 font-medium w-[50px]"></th>
                </tr>
              </thead>
              <tbody>
                {access.values.map((val, vIdx) => (
                  <tr key={vIdx} className={`border-t ${
                    isWrite
                      ? 'border-orange-100 dark:border-orange-900/30'
                      : 'border-slate-100 dark:border-slate-800/50'
                  }`}>
                    <td className={`pl-3 pr-2 py-0.5 font-mono align-top whitespace-nowrap ${
                      isWrite
                        ? 'text-orange-700 dark:text-orange-300'
                        : 'text-slate-600 dark:text-gray-400'
                    }`}>
                      {val.name || <span className="italic text-slate-400">(default)</span>}
                    </td>
                    <td className={`px-2 py-0.5 font-mono break-all ${
                      isWrite
                        ? 'text-orange-900 dark:text-orange-100'
                        : 'text-slate-800 dark:text-gray-200'
                    }`}>
                      {val.value || <span className="italic text-slate-400 dark:text-gray-500">(empty)</span>}
                    </td>
                    <td className="px-2 py-0.5 text-right">
                      {val.lineNumber > 0 && <LineLink line={val.lineNumber} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
