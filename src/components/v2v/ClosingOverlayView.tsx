/**
 * Structured visualization for the "Closing the overlay" pipeline stage.
 *
 * Shows the shutdown sequence: unmount, autosync, VM destroy,
 * NBDKIT/VDDK disconnect, temp cleanup, and any errors.
 */
import { useMemo } from 'react';
import { SectionHeader } from './shared';

// ── Types ───────────────────────────────────────────────────────────────────

interface MountEntry {
  fsname: string;
  dir: string;
  type: string;
}

interface ShutdownStep {
  label: string;
  status: 'ok' | 'error' | 'info';
  detail?: string;
}

interface ParsedClosing {
  mounts: MountEntry[];
  steps: ShutdownStep[];
  errors: string[];
  tempDirs: string[];
}

// ── Parser ──────────────────────────────────────────────────────────────────

function parseClosingContent(lines: string[]): ParsedClosing {
  const mounts: MountEntry[] = [];
  const steps: ShutdownStep[] = [];
  const errors: string[] = [];
  const tempDirs: string[] = [];
  const seenSteps = new Set<string>();

  const addStep = (label: string, status: 'ok' | 'error' | 'info', detail?: string) => {
    if (!seenSteps.has(label)) {
      seenSteps.add(label);
      steps.push({ label, status, detail });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── Mount entries ────────────────────────────────────────────────
    const mountMatch = line.match(
      /umount-all:.*fsname=(\S+)\s+dir=(\S+)\s+type=(\S+)/,
    );
    if (mountMatch) {
      const entry = { fsname: mountMatch[1], dir: mountMatch[2], type: mountMatch[3] };
      if (!mounts.some((m) => m.dir === entry.dir)) {
        mounts.push(entry);
      }
    }

    // ── Shutdown steps ───────────────────────────────────────────────
    if (line.includes('umount_all') && line.includes('= 0')) {
      addStep('Unmount all filesystems', 'ok');
    }
    if (line.includes('internal_autosync') && line.includes('= 0')) {
      addStep('Internal autosync', 'ok');
    }
    if (line.includes('virDomainDestroy')) {
      const flagMatch = line.match(/flags=(\S+)/);
      addStep(
        'Destroy appliance VM',
        'ok',
        flagMatch ? flagMatch[1] : undefined,
      );
    }
    if (line.includes('shutdown = 0')) {
      addStep('Shutdown libguestfs', 'ok');
    }
    if (line.includes('closing guestfs handle')) {
      const handleMatch = line.match(/handle\s+(0x[0-9a-f]+)/);
      addStep('Close guestfs handle', 'ok', handleMatch?.[1]);
    }

    // NBDKIT/VDDK disconnect
    if (line.includes('VixDiskLib_Disconnect')) {
      addStep('VDDK disconnect', 'ok');
    }
    if (line.includes('VixDiskLib_Close')) {
      addStep('VDDK close disk', 'ok');
    }
    if (line.includes('NBD_CMD_DISC') || line.includes('client sent unknown (0x2)')) {
      addStep('NBD client disconnect', 'ok');
    }

    // ── Errors ───────────────────────────────────────────────────────
    const errorMatch = line.match(/error\s+-\[.*?\]\s+(.+)/);
    if (errorMatch) {
      errors.push(errorMatch[1].trim());
    }

    // ── Temp dir cleanup ─────────────────────────────────────────────
    const rmMatch = line.match(/rm\s*$/) || line.match(/\\?\s*-rf\s+(\S+)/);
    if (rmMatch && rmMatch[1]) {
      tempDirs.push(rmMatch[1]);
    }
  }

  return { mounts, steps, errors, tempDirs };
}

// ── Component ───────────────────────────────────────────────────────────────

export function ClosingOverlayView({ content }: { content: string[] }) {
  const parsed = useMemo(() => parseClosingContent(content), [content]);

  const hasData = parsed.steps.length > 0 || parsed.mounts.length > 0;
  if (!hasData) return null;

  return (
    <div className="space-y-4">
      {/* Shutdown sequence */}
      {parsed.steps.length > 0 && <StepsSection steps={parsed.steps} />}

      {/* Mounted filesystems that were cleaned up */}
      {parsed.mounts.length > 0 && <MountsSection mounts={parsed.mounts} />}

      {/* Errors during shutdown */}
      {parsed.errors.length > 0 && <ErrorsSection errors={parsed.errors} />}

      {/* Temp dirs cleaned */}
      {parsed.tempDirs.length > 0 && <TempCleanupSection dirs={parsed.tempDirs} />}
    </div>
  );
}

// ── Sub-sections ────────────────────────────────────────────────────────────

function StepsSection({ steps }: { steps: ShutdownStep[] }) {
  return (
    <div>
      <SectionHeader title="Shutdown Sequence" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <div className="px-3 py-2 space-y-1">
          {steps.map((step, i) => (
            <div key={i} className="flex items-center gap-2 text-[11px]">
              <span className="flex-shrink-0">
                {step.status === 'ok' ? (
                  <span className="text-green-500 dark:text-green-400">&#10003;</span>
                ) : step.status === 'error' ? (
                  <span className="text-red-500 dark:text-red-400">&#10007;</span>
                ) : (
                  <span className="text-slate-400 dark:text-gray-500">&#8226;</span>
                )}
              </span>
              <span className="text-slate-700 dark:text-gray-200">{step.label}</span>
              {step.detail && (
                <span className="font-mono text-[9px] text-slate-400 dark:text-gray-500">
                  {step.detail}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MountsSection({ mounts }: { mounts: MountEntry[] }) {
  return (
    <div>
      <SectionHeader title="Unmounted Filesystems" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
              <th className="px-3 py-1 font-medium">Mount Point</th>
              <th className="px-3 py-1 font-medium">Device</th>
              <th className="px-3 py-1 font-medium">Type</th>
            </tr>
          </thead>
          <tbody>
            {mounts.map((m, i) => (
              <tr key={i} className="border-b border-slate-50 dark:border-slate-800/50 last:border-b-0">
                <td className="px-3 py-1 font-mono text-[10px] text-slate-700 dark:text-gray-200">{m.dir}</td>
                <td className="px-3 py-1 font-mono text-[10px] text-slate-500 dark:text-gray-400">{m.fsname}</td>
                <td className="px-3 py-1">
                  <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[9px] text-slate-500 dark:text-gray-400">
                    {m.type}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ErrorsSection({ errors }: { errors: string[] }) {
  return (
    <div>
      <SectionHeader title="Shutdown Warnings" />
      <div className="border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2 bg-amber-50 dark:bg-amber-900/10 space-y-1">
        {errors.map((err, i) => (
          <div key={i} className="text-[10px] font-mono text-amber-700 dark:text-amber-300">
            {err}
          </div>
        ))}
      </div>
    </div>
  );
}

function TempCleanupSection({ dirs }: { dirs: string[] }) {
  return (
    <div>
      <SectionHeader title="Temp Directory Cleanup" />
      <div className="flex flex-wrap gap-2">
        {dirs.map((d, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-gray-300 border-slate-200 dark:border-slate-700 font-mono"
          >
            <span className="text-red-400 dark:text-red-500">rm</span> {d}
          </span>
        ))}
      </div>
    </div>
  );
}
