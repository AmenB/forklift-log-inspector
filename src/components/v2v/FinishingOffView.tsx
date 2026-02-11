/**
 * Structured visualization for the "Finishing off" pipeline stage.
 *
 * Shows: finished status, temp directory cleanup, libguestfs handle closures,
 * nbdkit plugin/filter lifecycle, and VDDK function statistics tables.
 */
import { useMemo, useState } from 'react';
import { SectionHeader } from './shared';

// ── Types ───────────────────────────────────────────────────────────────────

interface TempCleanup {
  path: string;
  kind: 'nbdkit' | 'v2v' | 'other';
}

interface GuestfsHandle {
  address: string;
  state: string;
}

interface NbdkitLifecycle {
  plugin: string;
  action: 'cleanup' | 'unload';
}

interface VddkStatRow {
  func: string;
  microseconds: number;
  calls: number;
  bytes: number | null;
}

interface VddkStatTable {
  rows: VddkStatRow[];
}

interface ParsedFinishingOff {
  finished: boolean;
  tempCleanups: TempCleanup[];
  guestfsHandles: GuestfsHandle[];
  nbdkitLifecycle: NbdkitLifecycle[];
  vddkStats: VddkStatTable[];
  errors: string[];
}

// ── Parser ──────────────────────────────────────────────────────────────────

function parseFinishingOffContent(lines: string[]): ParsedFinishingOff {
  let finished = false;
  const tempCleanups: TempCleanup[] = [];
  const guestfsHandles: GuestfsHandle[] = [];
  const nbdkitLifecycle: NbdkitLifecycle[] = [];
  const vddkStats: VddkStatTable[] = [];
  const errors: string[] = [];
  const seenTempPaths = new Set<string>();

  let currentStatTable: VddkStatRow[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // ── Finished status ─────────────────────────────────────────────
    if (/virt-v2v\s+monitoring:\s*Finished/i.test(line)) {
      finished = true;
    }

    // ── Temp directory cleanup ──────────────────────────────────────
    const rmMatch = line.match(/rm\s+-rf\s+(?:--\s+)?['"]?([^'"]+?)['"]?\s*$/);
    if (rmMatch) {
      const path = rmMatch[1];
      if (!seenTempPaths.has(path)) {
        seenTempPaths.add(path);
        const kind = path.includes('v2vnbdkit')
          ? 'nbdkit' as const
          : path.includes('v2v')
            ? 'v2v' as const
            : 'other' as const;
        tempCleanups.push({ path, kind });
      }
    }

    // ── libguestfs handle closure ───────────────────────────────────
    const guestfsMatch = line.match(/closing guestfs handle\s+(0x[0-9a-f]+)\s*\(state\s+(\d+)\)/i);
    if (guestfsMatch) {
      guestfsHandles.push({ address: guestfsMatch[1], state: guestfsMatch[2] });
    }

    // ── nbdkit cleanup / unload ─────────────────────────────────────
    const cleanupMatch = line.match(/nbdkit:\s*debug:\s*(\S+):\s*cleanup/);
    if (cleanupMatch) {
      nbdkitLifecycle.push({ plugin: cleanupMatch[1], action: 'cleanup' });
    }
    const unloadMatch = line.match(/nbdkit:\s*debug:\s*(\S+):\s*unload\s+(plugin|filter)/);
    if (unloadMatch) {
      nbdkitLifecycle.push({ plugin: unloadMatch[1], action: 'unload' });
    }

    // ── VDDK function stats table ───────────────────────────────────
    if (line.includes('VDDK function stats')) {
      // Start a new table
      if (currentStatTable && currentStatTable.length > 0) {
        vddkStats.push({ rows: currentStatTable });
      }
      currentStatTable = [];
      continue;
    }

    // Parse stat header line (skip it)
    if (currentStatTable !== null && /VixDiskLib_\.\.\.\s+/.test(line)) {
      continue;
    }

    // Parse stat rows: "  FuncName    123456    12       456789"
    if (currentStatTable !== null) {
      const statMatch = line.match(/^\s*(\S+)\s+(\d+)\s+(\d+)(?:\s+(\d+))?\s*$/);
      if (statMatch) {
        currentStatTable.push({
          func: statMatch[1],
          microseconds: parseInt(statMatch[2], 10),
          calls: parseInt(statMatch[3], 10),
          bytes: statMatch[4] ? parseInt(statMatch[4], 10) : null,
        });
      } else if (line.length > 0 && !/nbdkit:\s*debug:/.test(line)) {
        // End of table — non-matching, non-empty, non-nbdkit line
        if (currentStatTable.length > 0) {
          vddkStats.push({ rows: currentStatTable });
        }
        currentStatTable = null;
      }
    }

    // ── Errors ──────────────────────────────────────────────────────
    if (/error/i.test(line) && !line.includes('nbdkit:') && !line.includes('VDDK')) {
      const errMatch = line.match(/error[:\s]+(.+)/i);
      if (errMatch) errors.push(errMatch[1].trim());
    }
  }

  // Flush any in-progress stat table
  if (currentStatTable && currentStatTable.length > 0) {
    vddkStats.push({ rows: currentStatTable });
  }

  return { finished, tempCleanups, guestfsHandles, nbdkitLifecycle, vddkStats, errors };
}

// ── Component ───────────────────────────────────────────────────────────────

export function FinishingOffView({ content }: { content: string[] }) {
  const parsed = useMemo(() => parseFinishingOffContent(content), [content]);

  const hasData =
    parsed.finished ||
    parsed.tempCleanups.length > 0 ||
    parsed.guestfsHandles.length > 0 ||
    parsed.vddkStats.length > 0;

  if (!hasData) return null;

  return (
    <div className="space-y-4">
      {/* Finished status banner */}
      {parsed.finished && <FinishedBanner />}

      {/* VDDK function statistics */}
      {parsed.vddkStats.length > 0 && (
        <VddkStatsSection tables={parsed.vddkStats} />
      )}

      {/* libguestfs handles closed */}
      {parsed.guestfsHandles.length > 0 && (
        <GuestfsHandlesSection handles={parsed.guestfsHandles} />
      )}

      {/* nbdkit lifecycle */}
      {parsed.nbdkitLifecycle.length > 0 && (
        <NbdkitLifecycleSection lifecycle={parsed.nbdkitLifecycle} />
      )}

      {/* Temp directory cleanup */}
      {parsed.tempCleanups.length > 0 && (
        <TempCleanupSection cleanups={parsed.tempCleanups} />
      )}

      {/* Errors */}
      {parsed.errors.length > 0 && (
        <ErrorsSection errors={parsed.errors} />
      )}
    </div>
  );
}

// ── Sub-sections ────────────────────────────────────────────────────────────

function FinishedBanner() {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/10">
      <span className="text-green-500 dark:text-green-400 text-base">&#10003;</span>
      <span className="text-[11px] font-medium text-green-700 dark:text-green-300">
        virt-v2v monitoring: Finished
      </span>
    </div>
  );
}

function VddkStatsSection({ tables }: { tables: VddkStatTable[] }) {
  return (
    <div>
      <SectionHeader title="VDDK Function Statistics" count={tables.length} />
      <div className="space-y-3">
        {tables.map((table, idx) => (
          <VddkStatTableCard key={idx} table={table} index={idx} total={tables.length} />
        ))}
      </div>
    </div>
  );
}

function VddkStatTableCard({ table, index, total }: { table: VddkStatTable; index: number; total: number }) {
  const [expanded, setExpanded] = useState(false);
  const totalCalls = table.rows.reduce((sum, r) => sum + r.calls, 0);
  const totalBytes = table.rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
  const totalMicroseconds = table.rows.reduce((sum, r) => sum + r.microseconds, 0);

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between px-3 py-2 bg-slate-50 dark:bg-slate-800/80 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/90 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-slate-400 dark:text-gray-500">{expanded ? '▼' : '▶'}</span>
          <span className="text-[11px] font-medium text-slate-700 dark:text-gray-200">
            {total > 1 ? `Disk ${index + 1}` : 'VDDK Calls'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-slate-500 dark:text-gray-400">
            {table.rows.length} functions
          </span>
          <span className="text-[10px] font-mono text-slate-500 dark:text-gray-400">
            {totalCalls} calls
          </span>
          {totalBytes > 0 && (
            <span className="text-[10px] font-mono text-slate-500 dark:text-gray-400">
              {formatBytes(totalBytes)}
            </span>
          )}
          <span className="text-[10px] font-mono text-slate-500 dark:text-gray-400">
            {formatMicroseconds(totalMicroseconds)}
          </span>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-slate-200 dark:border-slate-700/40">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
                <th className="px-3 py-1 font-medium">Function</th>
                <th className="px-3 py-1 font-medium text-right">Time</th>
                <th className="px-3 py-1 font-medium text-right">Calls</th>
                <th className="px-3 py-1 font-medium text-right">Bytes</th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-slate-50 dark:border-slate-800/50 last:border-b-0"
                >
                  <td className="px-3 py-1 font-mono text-slate-700 dark:text-gray-200">
                    VixDiskLib_{row.func}
                  </td>
                  <td className="px-3 py-1 font-mono text-right text-slate-500 dark:text-gray-400">
                    {formatMicroseconds(row.microseconds)}
                  </td>
                  <td className="px-3 py-1 font-mono text-right text-slate-500 dark:text-gray-400">
                    {row.calls.toLocaleString()}
                  </td>
                  <td className="px-3 py-1 font-mono text-right text-slate-500 dark:text-gray-400">
                    {row.bytes !== null ? formatBytes(row.bytes) : '—'}
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

function GuestfsHandlesSection({ handles }: { handles: GuestfsHandle[] }) {
  return (
    <div>
      <SectionHeader title="Libguestfs Handles Closed" count={handles.length} />
      <div className="flex flex-wrap gap-2">
        {handles.map((h, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] border bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-gray-300 border-slate-200 dark:border-slate-700 font-mono"
          >
            <span className="text-green-500 dark:text-green-400">&#10003;</span>
            {h.address}
            <span className="text-slate-400 dark:text-gray-500">state={h.state}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function NbdkitLifecycleSection({ lifecycle }: { lifecycle: NbdkitLifecycle[] }) {
  // Group by plugin, show cleanup → unload progression
  const pluginMap = new Map<string, Set<string>>();
  for (const entry of lifecycle) {
    if (!pluginMap.has(entry.plugin)) pluginMap.set(entry.plugin, new Set());
    pluginMap.get(entry.plugin)!.add(entry.action);
  }
  const plugins = Array.from(pluginMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div>
      <SectionHeader title="nbdkit Plugin/Filter Lifecycle" count={plugins.length} />
      <div className="flex flex-wrap gap-1.5">
        {plugins.map(([name, actions], i) => {
          const cleaned = actions.has('cleanup');
          const unloaded = actions.has('unload');
          return (
            <span
              key={i}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700 font-mono"
            >
              <span className={unloaded ? 'text-green-500 dark:text-green-400' : 'text-slate-400 dark:text-gray-500'}>
                {unloaded ? '●' : '○'}
              </span>
              <span className="text-slate-700 dark:text-gray-200">{name}</span>
              <span className="text-[9px] text-slate-400 dark:text-gray-500">
                {cleaned && unloaded ? 'cleaned+unloaded' : cleaned ? 'cleaned' : 'unloaded'}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function TempCleanupSection({ cleanups }: { cleanups: TempCleanup[] }) {
  const kindColors: Record<TempCleanup['kind'], string> = {
    nbdkit: 'text-purple-500 dark:text-purple-400',
    v2v: 'text-sky-500 dark:text-sky-400',
    other: 'text-slate-400 dark:text-gray-500',
  };

  return (
    <div>
      <SectionHeader title="Temp Directory Cleanup" count={cleanups.length} />
      <div className="flex flex-wrap gap-2">
        {cleanups.map((c, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-gray-300 border-slate-200 dark:border-slate-700 font-mono"
          >
            <span className={kindColors[c.kind]}>rm</span>
            {c.path}
          </span>
        ))}
      </div>
    </div>
  );
}

function ErrorsSection({ errors }: { errors: string[] }) {
  return (
    <div>
      <SectionHeader title="Errors" />
      <div className="border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 bg-red-50 dark:bg-red-900/10 space-y-1">
        {errors.map((err, i) => (
          <div key={i} className="text-[10px] font-mono text-red-700 dark:text-red-300">
            {err}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Formatters ──────────────────────────────────────────────────────────────

function formatMicroseconds(us: number): string {
  if (us >= 1_000_000) return `${(us / 1_000_000).toFixed(2)}s`;
  if (us >= 1_000) return `${(us / 1_000).toFixed(1)}ms`;
  return `${us}µs`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GiB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
