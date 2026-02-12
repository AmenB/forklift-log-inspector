/**
 * Parser for the "SELinux relabelling" pipeline stage.
 *
 * Parses SELinux configuration, augeas parse errors, mount points,
 * setfiles execution details, and the relabelled files summary.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface SELinuxConfig {
  loadPolicyFound: boolean;
  selinuxRelabelAvailable: boolean;
  mode: string; // enforcing / permissive / disabled / disable
  type: string; // targeted / mls / minimum
  fileContextsPath: string;
}

export interface AugeasError {
  file: string;
  line: string;
  char: string;
  message: string;
}

export interface MountPoint {
  device: string;
  path: string;
}

export interface SetfilesExec {
  command: string;
  durationSecs: number | null;
  exitCode: number | null;
  skippedBins: string[];
  contextErrors: string[]; // "Could not set context for X: ..."
  autorelabelRemoved: boolean;
}

export interface RelabeledFile {
  path: string; // stripped of /sysroot/ prefix
  fromContext: string;
  toContext: string;
}

export interface RelabelGroup {
  directory: string;
  files: RelabeledFile[];
}

export interface ParsedSELinux {
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
export const RELABEL_RE = /^\s*[Rr]elabeled\s+(\S+)\s+from\s+(.+?)\s+to\s+(.+?)\s*$/;

// ── Parser ──────────────────────────────────────────────────────────────────

export function parseSELinuxContent(lines: string[], extraRelabelLines?: string[]): ParsedSELinux {
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
    if ((line.includes('aug_get "/files/etc/selinux/config/SELINUX"') || line.includes('aug_get "/file/etc/selinux/config/SELINUX"')) &&
        !line.includes('/etc/selinux/config/SELINUXTYPE"')) {
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

    if (line.includes('aug_get "/files/etc/selinux/config/SELINUXTYPE"') || line.includes('aug_get "/file/etc/selinux/config/SELINUXTYPE"')) {
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
