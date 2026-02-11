/**
 * Structured visualization for the "Setting the hostname" pipeline stage.
 *
 * Parses the hostname being set, detected OS type/version,
 * and any warnings about hostname not being settable.
 */
import { useMemo } from 'react';

// ── Types ───────────────────────────────────────────────────────────────────

interface ParsedHostname {
  hostname: string;
  osType: string;       // e.g. "windows"
  osDistro: string;     // e.g. "windows"
  osMajorVersion: number | null;
  warnings: string[];
  errors: string[];
  machineIdMissing: boolean;
}

// ── Parser ──────────────────────────────────────────────────────────────────

function parseHostnameContent(lines: string[], stageName: string): ParsedHostname {
  const result: ParsedHostname = {
    hostname: '',
    osType: '',
    osDistro: '',
    osMajorVersion: null,
    warnings: [],
    errors: [],
    machineIdMissing: false,
  };

  // Extract hostname from stage name: "Setting the hostname: <hostname>"
  const nameMatch = stageName.match(/hostname[:\s]+(\S+)/i);
  if (nameMatch) {
    result.hostname = nameMatch[1];
  }

  for (const line of lines) {
    // ── OS type ───────────────────────────────────────────────────────
    const typeMatch = line.match(/inspect_get_type = "(.+?)"/);
    if (typeMatch && !result.osType) {
      result.osType = typeMatch[1];
    }

    // ── OS distro ─────────────────────────────────────────────────────
    const distroMatch = line.match(/inspect_get_distro = "(.+?)"/);
    if (distroMatch && !result.osDistro) {
      result.osDistro = distroMatch[1];
    }

    // ── OS major version ──────────────────────────────────────────────
    const majorMatch = line.match(/inspect_get_major_version = (\d+)/);
    if (majorMatch && result.osMajorVersion === null) {
      result.osMajorVersion = parseInt(majorMatch[1], 10);
    }

    // ── machine-id missing ────────────────────────────────────────────
    if (line.includes('/etc/machine-id') && line.includes('No such file')) {
      result.machineIdMissing = true;
    }

    // ── virt-v2v warnings ─────────────────────────────────────────────
    const warnMatch = line.match(/virt-v2v:\s*warning:\s*(.+)/);
    if (warnMatch) {
      const msg = warnMatch[1].trim();
      if (!result.warnings.includes(msg)) {
        result.warnings.push(msg);
      }
    }

    // ── Errors (from guestfsd) ────────────────────────────────────────
    const errMatch = line.match(/guestfsd:\s*error:\s*(.+)/);
    if (errMatch) {
      const msg = errMatch[1].trim();
      if (!result.errors.includes(msg)) {
        result.errors.push(msg);
      }
    }
  }

  return result;
}

// ── Component ───────────────────────────────────────────────────────────────

export function HostnameView({ content, stageName }: { content: string[]; stageName: string }) {
  const parsed = useMemo(() => parseHostnameContent(content, stageName), [content, stageName]);

  const hasWarning = parsed.warnings.length > 0;
  const hasError = parsed.errors.length > 0;
  const succeeded = !hasWarning && !hasError;

  return (
    <div className="space-y-3">
      {/* Status banner */}
      <div
        className={`flex items-center gap-2 rounded-lg px-3 py-2 text-[11px] border ${
          hasWarning
            ? 'bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300'
            : succeeded
              ? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
              : 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
        }`}
      >
        <span className="text-base flex-shrink-0">
          {hasWarning ? '\u26A0' : succeeded ? '\u2713' : '\u2717'}
        </span>
        <div>
          {hasWarning
            ? parsed.warnings.map((w, i) => <div key={i}>{w}</div>)
            : succeeded
              ? <span>Hostname set successfully</span>
              : parsed.errors.map((e, i) => <div key={i}>{e}</div>)
          }
        </div>
      </div>

      {/* Details card */}
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px]">
          {parsed.hostname && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">Hostname:</span>{' '}
              <span className="font-mono font-medium text-slate-700 dark:text-gray-200">{parsed.hostname}</span>
            </div>
          )}
          {parsed.osType && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">OS Type:</span>{' '}
              <span className="font-medium text-slate-700 dark:text-gray-200 capitalize">{parsed.osType}</span>
            </div>
          )}
          {parsed.osDistro && parsed.osDistro !== parsed.osType && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">Distro:</span>{' '}
              <span className="font-medium text-slate-700 dark:text-gray-200 capitalize">{parsed.osDistro}</span>
            </div>
          )}
          {parsed.osMajorVersion !== null && (
            <div>
              <span className="text-slate-500 dark:text-gray-400">Version:</span>{' '}
              <span className="font-mono font-medium text-slate-700 dark:text-gray-200">{parsed.osMajorVersion}</span>
            </div>
          )}
        </div>

        {/* Additional info badges */}
        {parsed.machineIdMissing && (
          <div className="mt-2 flex flex-wrap gap-1">
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-gray-400">
              /etc/machine-id not found
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
