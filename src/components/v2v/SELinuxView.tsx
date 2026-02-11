/**
 * Structured visualization for the "SELinux relabelling" pipeline stage.
 *
 * Parses SELinux configuration, augeas parse errors, mount points,
 * setfiles execution details, and the relabelled files summary.
 */
import { useMemo, useState } from 'react';
import type { V2VToolRun } from '../../types/v2v';
import { SectionHeader } from './shared';

// ── Types ───────────────────────────────────────────────────────────────────

interface SELinuxConfig {
  loadPolicyFound: boolean;
  selinuxRelabelAvailable: boolean;
  mode: string; // enforcing / permissive / disabled / disable
  type: string; // targeted / mls / minimum
  fileContextsPath: string;
}

interface AugeasError {
  file: string;
  line: string;
  char: string;
  message: string;
}

interface MountPoint {
  device: string;
  path: string;
}

interface SetfilesExec {
  command: string;
  durationSecs: number | null;
  exitCode: number | null;
  skippedBins: string[];
  contextErrors: string[]; // "Could not set context for X: ..."
  autorelabelRemoved: boolean;
}

interface RelabeledFile {
  path: string; // stripped of /sysroot/ prefix
  fromContext: string;
  toContext: string;
}

interface RelabelGroup {
  directory: string;
  files: RelabeledFile[];
}

interface ParsedSELinux {
  config: SELinuxConfig;
  augeasErrors: AugeasError[];
  mountPoints: MountPoint[];
  setfiles: SetfilesExec;
  relabelGroups: RelabelGroup[];
  totalRelabeled: number;
}

// ── Shared regex for Relabeled lines ─────────────────────────────────────────
// Matches: Relabeled /path from <context> to <context>
// Uses lazy .+? quantifiers and \s*$ to tolerate trailing \r / whitespace.
const RELABEL_RE = /^\s*[Rr]elabeled\s+(\S+)\s+from\s+(.+?)\s+to\s+(.+?)\s*$/;

// ── Parser ──────────────────────────────────────────────────────────────────

function parseSELinuxContent(lines: string[], extraRelabelLines?: string[]): ParsedSELinux {
  const config: SELinuxConfig = {
    loadPolicyFound: false,
    selinuxRelabelAvailable: false,
    mode: '',
    type: '',
    fileContextsPath: '',
  };

  const augeasErrors: AugeasError[] = [];
  const mountPoints: MountPoint[] = [];

  const setfiles: SetfilesExec = {
    command: '',
    durationSecs: null,
    exitCode: null,
    skippedBins: [],
    contextErrors: [],
    autorelabelRemoved: false,
  };

  const relabeledFiles: RelabeledFile[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── load_policy detection ─────────────────────────────────────────
    if (line.includes('is_file "/usr/sbin/load_policy"')) {
      // Look for the result on same or subsequent lines
      const resultMatch = line.match(/is_file\s*=\s*(\d)/);
      if (resultMatch) {
        config.loadPolicyFound = resultMatch[1] === '1';
      } else {
        // Check next few lines
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const rMatch = lines[j].match(/is_file\s*=\s*(\d)/);
          if (rMatch) {
            config.loadPolicyFound = rMatch[1] === '1';
            break;
          }
        }
      }
    }

    // ── selinuxrelabel feature detection ─────────────────────────────
    if (line.includes('feature_available = 1') && !config.selinuxRelabelAvailable) {
      // Check prior lines for the selinuxrelabel feature check
      for (let j = Math.max(0, i - 5); j < i; j++) {
        if (lines[j].includes('feature_available "selinuxrelabel"') ||
            lines[j].includes('internal_feature_available "selinuxrelabel"')) {
          config.selinuxRelabelAvailable = true;
          break;
        }
      }
    }

    // ── SELinux config from augeas ────────────────────────────────────
    // Use precise match to avoid SELINUX matching SELINUXTYPE (substring issue)
    if (line.includes('aug_get "/files/etc/selinux/config/SELINUX"') &&
        !line.includes('aug_get "/files/etc/selinux/config/SELINUXTYPE"')) {
      const valMatch = line.match(/aug_get\s*=\s*"([^"]+)"/);
      if (valMatch) {
        config.mode = valMatch[1];
      } else {
        // Lookahead up to 8 lines (interleaved guestfsd/libguestfs chatter can push result far)
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const m = lines[j].match(/aug_get\s*=\s*"([^"]+)"/);
          if (m) { config.mode = m[1]; break; }
        }
      }
    }

    if (line.includes('aug_get "/files/etc/selinux/config/SELINUXTYPE"')) {
      const valMatch = line.match(/aug_get\s*=\s*"([^"]+)"/);
      if (valMatch) {
        config.type = valMatch[1];
      } else {
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const m = lines[j].match(/aug_get\s*=\s*"([^"]+)"/);
          if (m) { config.type = m[1]; break; }
        }
      }
    }

    // ── File contexts path ────────────────────────────────────────────
    const fctxMatch = line.match(/is_file "([^"]*file_contexts)"/);
    if (fctxMatch && !config.fileContextsPath) {
      config.fileContextsPath = fctxMatch[1];
    }

    // ── Augeas parse errors ───────────────────────────────────────────
    const augErrMatch = line.match(/^augeas failed to parse ([^:]+):/);
    if (augErrMatch) {
      const file = augErrMatch[1];
      // Error details may be on the same line, next line, or a few lines ahead
      let found = false;
      // Check same line first
      const sameLine = line.match(/error\s+"([^"]+)"\s+at\s+line\s+(\d+)\s+char\s+(\d+)/);
      if (sameLine) {
        augeasErrors.push({ file, message: sameLine[1], line: sameLine[2], char: sameLine[3] });
        found = true;
      }
      if (!found) {
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          const detailMatch = lines[j].match(
            /error\s+"([^"]+)"\s+at\s+line\s+(\d+)\s+char\s+(\d+)/,
          );
          if (detailMatch) {
            augeasErrors.push({ file, message: detailMatch[1], line: detailMatch[2], char: detailMatch[3] });
            break;
          }
        }
      }
    }

    // ── Mount points ──────────────────────────────────────────────────
    const mpMatch = line.match(/mountpoints\s*=\s*\[(.+)\]/);
    if (mpMatch) {
      const pairs = mpMatch[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
      for (let p = 0; p < pairs.length - 1; p += 2) {
        if (pairs[p] && pairs[p + 1]) {
          mountPoints.push({ device: pairs[p], path: pairs[p + 1] });
        }
      }
    }

    // ── Setfiles command (the long one with -F) ──────────────────────
    if (line.includes("setfiles '-F'") || line.includes("setfiles: '-F'")) {
      setfiles.command = line.replace(/^command:\s*/, '').trim();
    }

    // ── Setfiles duration ────────────────────────────────────────────
    const sfDurMatch = line.match(/setfiles.*took\s+([\d.]+)\s+secs/);
    if (sfDurMatch) {
      setfiles.durationSecs = parseFloat(sfDurMatch[1]);
    }

    // ── Setfiles exit code ───────────────────────────────────────────
    // Only track exit code after the actual -F command is found, to ignore
    // flag-probing calls (setfiles -m, -C, -T that return 255).
    const sfExitMatch = line.match(/setfiles returned (\d+)/);
    if (sfExitMatch) {
      const code = parseInt(sfExitMatch[1], 10);
      if (setfiles.command) {
        // After the real command was found, this is the authoritative exit code
        setfiles.exitCode = code;
      } else if (setfiles.exitCode === null) {
        // Before real command found, only track if we haven't seen any yet (fallback)
        setfiles.exitCode = code;
      }
    }

    // ── Skipped bin files ────────────────────────────────────────────
    if (line.includes('Old compiled fcontext format, skipping')) {
      const binMatch = line.match(/^([^:]+):/);
      if (binMatch) {
        setfiles.skippedBins.push(binMatch[1].trim());
      } else {
        setfiles.skippedBins.push(line.trim());
      }
    }

    // ── Context errors (Could not set context) ──────────────────────
    const ctxErrMatch = line.match(/Could not set context for ([^:]+):\s*(.*)/);
    if (ctxErrMatch) {
      setfiles.contextErrors.push(ctxErrMatch[1].replace('/sysroot/', '/'));
    }

    // ── Autorelabel removal ──────────────────────────────────────────
    if (line.includes('rm_f "/.autorelabel"')) {
      setfiles.autorelabelRemoved = true;
    }

    // ── Relabeled files ──────────────────────────────────────────────
    // Allow optional leading whitespace and case-insensitive "Relabeled".
    // Strip interleaved nbdkit/guestfsd noise that can corrupt mid-line output.
    // Always trim to remove trailing \r / whitespace that can break the $ anchor.
    let relabelLine = line.trim();
    if (relabelLine.includes('nbdkit:') || relabelLine.includes('guestfsd:')) {
      relabelLine = relabelLine
        .replace(/nbdkit:\s*\S+:\s*debug:\s*\S+:\s*\S+/g, '')
        .replace(/guestfsd:\s*[<=>][^\n]*/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
    const relabelMatch = relabelLine.match(RELABEL_RE);
    if (relabelMatch) {
      let path = relabelMatch[1];
      if (path.startsWith('/sysroot/')) {
        path = path.slice('/sysroot'.length); // keep leading /
      }
      relabeledFiles.push({
        path,
        fromContext: relabelMatch[2].trim(),
        toContext: relabelMatch[3].trim(),
      });
    }
  }

  // Also parse Relabeled lines from the setfiles command's captured stdout.
  // These lines often appear AFTER the next stage marker in the log due to
  // output buffering, so they may not be in the stage content lines.
  if (extraRelabelLines) {
    const seen = new Set(relabeledFiles.map((f) => f.path));
    for (const rawLine of extraRelabelLines) {
      const m = rawLine.trim().match(RELABEL_RE);
      if (m) {
        let path = m[1];
        if (path.startsWith('/sysroot/')) {
          path = path.slice('/sysroot'.length);
        }
        if (!seen.has(path)) {
          seen.add(path);
          relabeledFiles.push({
            path,
            fromContext: m[2].trim(),
            toContext: m[3].trim(),
          });
        }
      }
    }
  }

  // Group relabeled files by top-level directory
  const groupMap = new Map<string, RelabeledFile[]>();
  for (const f of relabeledFiles) {
    const parts = f.path.split('/').filter(Boolean);
    const topDir = parts.length > 1 ? `/${parts[0]}` : '/';
    if (!groupMap.has(topDir)) groupMap.set(topDir, []);
    groupMap.get(topDir)!.push(f);
  }

  // Sort groups by count descending
  const relabelGroups = Array.from(groupMap.entries())
    .map(([directory, files]) => ({ directory, files }))
    .sort((a, b) => b.files.length - a.files.length);

  return {
    config,
    augeasErrors,
    mountPoints,
    setfiles,
    relabelGroups,
    totalRelabeled: relabeledFiles.length,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract all Relabeled lines from the tool run's raw lines.
 *
 * The setfiles stdout (containing Relabeled entries) is often written to the
 * log AFTER the next stage marker due to output buffering. The stage content
 * only includes lines within the stage boundary, so we also scan all raw
 * lines in the entire tool run to find any Relabeled entries that were missed.
 */
function extractAllRelabeledLines(toolRun?: V2VToolRun): string[] {
  if (!toolRun) return [];
  const result: string[] = [];
  for (const line of toolRun.rawLines) {
    if (/^\s*[Rr]elabeled\s+/.test(line)) {
      result.push(line);
    }
  }
  return result;
}

// ── Component ───────────────────────────────────────────────────────────────

export function SELinuxView({ content, toolRun }: { content: string[]; toolRun?: V2VToolRun }) {
  const allRelabeledLines = useMemo(() => extractAllRelabeledLines(toolRun), [toolRun]);
  const parsed = useMemo(
    () => parseSELinuxContent(content, allRelabeledLines.length > 0 ? allRelabeledLines : undefined),
    [content, allRelabeledLines],
  );

  // If nothing at all was found, show a simple message
  const hasAnyData = parsed.config.loadPolicyFound
    || parsed.config.mode
    || parsed.config.type
    || parsed.config.selinuxRelabelAvailable
    || parsed.augeasErrors.length > 0
    || parsed.mountPoints.length > 0
    || parsed.setfiles.exitCode !== null
    || parsed.totalRelabeled > 0;

  if (!hasAnyData) {
    return (
      <div className="px-3 py-4 text-center">
        <span className="text-xs text-slate-400 dark:text-gray-500 italic">
          No SELinux relabelling data found in this stage.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* SELinux Config */}
      {(parsed.config.mode || parsed.config.type || parsed.config.loadPolicyFound || parsed.config.selinuxRelabelAvailable) && (
        <ConfigSection config={parsed.config} />
      )}

      {/* Mount Points */}
      {parsed.mountPoints.length > 0 && (
        <MountPointsSection mounts={parsed.mountPoints} />
      )}

      {/* Augeas Warnings */}
      {parsed.augeasErrors.length > 0 && (
        <AugeasErrorsSection errors={parsed.augeasErrors} />
      )}

      {/* Setfiles Execution */}
      {(parsed.setfiles.durationSecs !== null ||
        parsed.setfiles.exitCode !== null ||
        parsed.setfiles.contextErrors.length > 0) && (
        <SetfilesSection setfiles={parsed.setfiles} />
      )}

      {/* Relabelling Summary */}
      {parsed.totalRelabeled > 0 && (
        <RelabelSummarySection
          groups={parsed.relabelGroups}
          total={parsed.totalRelabeled}
        />
      )}

    </div>
  );
}

// ── Sub-sections ────────────────────────────────────────────────────────────

function ConfigSection({ config }: { config: SELinuxConfig }) {
  // Normalize mode: "disable" → "disabled"
  const mode = config.mode === 'disable' ? 'disabled' : config.mode;

  const modeColor =
    mode === 'enforcing'
      ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800'
      : mode === 'permissive'
        ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800'
        : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800';

  return (
    <div>
      <SectionHeader title="SELinux Configuration" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
        <div className="flex items-center gap-3 flex-wrap">
          {mode && (
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${modeColor}`}>
              SELINUX: {mode}
            </span>
          )}
          {config.type && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800">
              Type: {config.type}
            </span>
          )}
          {config.loadPolicyFound && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800">
              load_policy: found
            </span>
          )}
          {config.selinuxRelabelAvailable && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800">
              relabel: available
            </span>
          )}
          {config.fileContextsPath && (
            <span className="font-mono text-[10px] text-slate-500 dark:text-gray-400">
              {config.fileContextsPath}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function MountPointsSection({ mounts }: { mounts: MountPoint[] }) {
  return (
    <div>
      <SectionHeader title="Relabelled Filesystems" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
              <th className="px-3 py-1 font-medium">Device</th>
              <th className="px-3 py-1 font-medium">Mount Point</th>
            </tr>
          </thead>
          <tbody>
            {mounts.map((m, i) => (
              <tr key={i} className="border-b border-slate-50 dark:border-slate-800/50 last:border-b-0">
                <td className="px-3 py-1 font-mono text-[10px] text-slate-600 dark:text-gray-300">{m.device}</td>
                <td className="px-3 py-1 font-mono text-[10px] text-slate-700 dark:text-gray-200">{m.path}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AugeasErrorsSection({ errors }: { errors: AugeasError[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 mb-2 group"
      >
        <svg
          className={`w-3 h-3 text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-gray-400 group-hover:text-slate-700 dark:group-hover:text-gray-300 transition-colors">
          Augeas Parse Warnings
        </h4>
        <span className="px-1.5 py-0 rounded-full bg-amber-100 dark:bg-amber-900/30 text-[10px] text-amber-700 dark:text-amber-300">
          {errors.length}
        </span>
      </button>
      {expanded && (
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-slate-400 dark:text-gray-500 border-b border-slate-100 dark:border-slate-800">
                <th className="px-3 py-1 font-medium">File</th>
                <th className="px-3 py-1 font-medium">Line</th>
                <th className="px-3 py-1 font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((e, i) => (
                <tr key={i} className="border-b border-slate-50 dark:border-slate-800/50 last:border-b-0">
                  <td className="px-3 py-1 font-mono text-[10px] text-slate-600 dark:text-gray-300">{e.file}</td>
                  <td className="px-3 py-1 text-slate-500 dark:text-gray-400">
                    {e.line}:{e.char}
                  </td>
                  <td className="px-3 py-1 text-amber-600 dark:text-amber-400">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SetfilesSection({ setfiles }: { setfiles: SetfilesExec }) {
  const [errorsExpanded, setErrorsExpanded] = useState(false);

  return (
    <div>
      <SectionHeader title="Setfiles Execution" />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 space-y-2">
        {/* Stats row */}
        <div className="flex items-center gap-3 flex-wrap">
          {setfiles.exitCode !== null && (
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${
                setfiles.exitCode <= 1
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800'
              }`}
            >
              exit {setfiles.exitCode}
            </span>
          )}
          {setfiles.durationSecs !== null && (
            <span className="text-[10px] text-slate-500 dark:text-gray-400">
              {setfiles.durationSecs.toFixed(2)}s
            </span>
          )}
          {setfiles.autorelabelRemoved && (
            <span className="text-[10px] text-slate-400 dark:text-gray-500 italic">
              .autorelabel removed
            </span>
          )}
          {setfiles.skippedBins.length > 0 && (
            <span className="text-[10px] text-slate-400 dark:text-gray-500">
              {setfiles.skippedBins.length} old .bin file{setfiles.skippedBins.length > 1 ? 's' : ''} skipped
            </span>
          )}
        </div>

        {/* Context errors */}
        {setfiles.contextErrors.length > 0 && (
          <div>
            <button
              onClick={() => setErrorsExpanded(!errorsExpanded)}
              className="flex items-center gap-1.5 text-[10px] text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 transition-colors"
            >
              <svg
                className={`w-2.5 h-2.5 transition-transform ${errorsExpanded ? 'rotate-90' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              {setfiles.contextErrors.length} file{setfiles.contextErrors.length > 1 ? 's' : ''} could not be relabelled
            </button>
            {errorsExpanded && (
              <div className="mt-1 pl-4 space-y-0.5">
                {setfiles.contextErrors.map((path, i) => (
                  <div key={i} className="font-mono text-[10px] text-slate-500 dark:text-gray-400">
                    {path}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Relabel Tree ────────────────────────────────────────────────────────────

interface RelabelTreeNode {
  name: string;
  path: string;
  children: Map<string, RelabelTreeNode>;
  /** Leaf file data (null for directories) */
  file: RelabeledFile | null;
}

function buildRelabelTree(files: RelabeledFile[]): RelabelTreeNode {
  const root: RelabelTreeNode = { name: '/', path: '/', children: new Map(), file: null };

  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    let node = root;
    let currentPath = '';

    for (let i = 0; i < parts.length; i++) {
      currentPath += '/' + parts[i];
      const isLeaf = i === parts.length - 1;

      if (!node.children.has(parts[i])) {
        node.children.set(parts[i], {
          name: parts[i],
          path: currentPath,
          children: new Map(),
          file: isLeaf ? f : null,
        });
      } else if (isLeaf) {
        node.children.get(parts[i])!.file = f;
      }
      node = node.children.get(parts[i])!;
    }
  }

  return root;
}

/** Collapse single-child directory chains into one node (e.g. "root/.cache/mesa_shader_cache") */
function collapseTree(node: RelabelTreeNode): RelabelTreeNode {
  // Collapse children first (bottom-up)
  const newChildren = new Map<string, RelabelTreeNode>();
  for (const [key, child] of node.children) {
    newChildren.set(key, collapseTree(child));
  }
  node.children = newChildren;

  // If this is a dir with exactly one child that is also a dir, merge them
  if (node.file === null && node.children.size === 1) {
    const [, onlyChild] = [...node.children.entries()][0];
    if (onlyChild.file === null && onlyChild.children.size > 0) {
      return {
        name: node.name === '/' ? onlyChild.name : node.name + '/' + onlyChild.name,
        path: onlyChild.path,
        children: onlyChild.children,
        file: null,
      };
    }
  }

  return node;
}

function countTreeFiles(node: RelabelTreeNode): number {
  if (node.file) return 1;
  let count = 0;
  for (const child of node.children.values()) {
    count += countTreeFiles(child);
  }
  return count;
}

function RelabelSummarySection({
  groups,
  total,
}: {
  groups: RelabelGroup[];
  total: number;
}) {
  // Build a single tree from all files across all groups
  const allFiles = useMemo(
    () => groups.flatMap((g) => g.files),
    [groups],
  );
  const tree = useMemo(() => collapseTree(buildRelabelTree(allFiles)), [allFiles]);

  // Sort root children: directories first, then by file count desc
  const sortedRootChildren = useMemo(() => {
    return [...tree.children.values()].sort((a, b) => {
      const aIsDir = a.file === null;
      const bIsDir = b.file === null;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return countTreeFiles(b) - countTreeFiles(a);
    });
  }, [tree]);

  return (
    <div>
      <SectionHeader title="Relabelled Files" badge={String(total)} />
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden max-h-[500px] overflow-y-auto">
        <div className="py-1">
          {sortedRootChildren.map((child) => (
            <RelabelTreeNodeRow key={child.path} node={child} depth={0} />
          ))}
        </div>
      </div>
    </div>
  );
}

function RelabelTreeNodeRow({ node, depth }: { node: RelabelTreeNode; depth: number }) {
  const isDir = node.file === null && node.children.size > 0;
  const [expanded, setExpanded] = useState(depth === 0);

  const fileCount = useMemo(() => (isDir ? countTreeFiles(node) : 0), [isDir, node]);

  // Sort children: dirs first, then alphabetically
  const sortedChildren = useMemo(() => {
    return [...node.children.values()].sort((a, b) => {
      const aIsDir = a.file === null && a.children.size > 0;
      const bIsDir = b.file === null && b.children.size > 0;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [node]);

  return (
    <div>
      <div
        onClick={isDir ? () => setExpanded(!expanded) : undefined}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        className={`
          flex items-center gap-1.5 py-[2px] text-[11px] transition-colors
          ${isDir ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50' : ''}
        `}
      >
        {/* Expand arrow (dirs only) */}
        {isDir ? (
          <span className="text-[9px] text-indigo-500 dark:text-indigo-400 w-3 text-center flex-shrink-0">
            {expanded ? '\u25BC' : '\u25B6'}
          </span>
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}

        {/* Icon */}
        <span className="text-[10px] flex-shrink-0">
          {isDir ? (
            <span className="text-amber-500 dark:text-amber-400">{expanded ? '\uD83D\uDCC2' : '\uD83D\uDCC1'}</span>
          ) : (
            <span className="text-slate-400 dark:text-gray-500">{'\uD83D\uDCC4'}</span>
          )}
        </span>

        {/* Name */}
        <span className={`font-mono text-[10px] flex-shrink-0 ${isDir ? 'text-slate-800 dark:text-gray-200 font-medium' : 'text-slate-700 dark:text-gray-300'}`}>
          {node.name}{isDir ? '/' : ''}
        </span>

        {/* Dir: file count */}
        {isDir && (
          <span className="px-1.5 py-0 rounded-full bg-slate-100 dark:bg-slate-800 text-[9px] text-slate-500 dark:text-gray-400">
            {fileCount}
          </span>
        )}

        {/* Leaf: inline context change */}
        {!isDir && node.file && <InlineContextChange file={node.file} />}
      </div>

      {/* Dir children */}
      {isDir && expanded && sortedChildren.map((child) => (
        <RelabelTreeNodeRow key={child.path} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

/** Renders context change inline after the filename: old → new with color coding */
function InlineContextChange({ file }: { file: RelabeledFile }) {
  const isNew = file.fromContext === '<no context>';

  // Detect what changed
  const fromParts = file.fromContext.split(':');
  const toParts = file.toContext.split(':');
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
        <span className={toColor}>{file.toContext}</span>
      ) : (
        <>
          <span className="text-slate-400 dark:text-gray-600 line-through truncate max-w-[180px]" title={file.fromContext}>
            {file.fromContext}
          </span>
          <span className="text-slate-300 dark:text-gray-600 flex-shrink-0">{'\u2192'}</span>
          <span className={`${toColor} truncate max-w-[180px]`} title={file.toContext}>
            {file.toContext}
          </span>
        </>
      )}
    </span>
  );
}
