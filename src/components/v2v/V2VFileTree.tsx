import { useState, useMemo, useCallback, useEffect, useRef, createContext, useContext } from 'react';
import type { V2VApiCall, V2VDriveMapping, V2VFstabEntry, V2VFileCopy } from '../../types/v2v';
import { LineLink } from './LineLink';
import { formatBytes } from '../../utils/format';
import { OriginBadge } from './shared';

// ────────────────────────────────────────────────────────────────────────────
// Cross-tree navigation context
// ────────────────────────────────────────────────────────────────────────────

interface FileTreeNav {
  /** Path currently focused in the ISO tree (e.g. /Balloon/2k19/amd64/balloon.inf) */
  focusedPath: string | null;
  /** Monotonically increasing — forces re-triggers even when re-clicking the same path */
  focusedVersion: number;
  /** Called by CopySourceRow to navigate into the ISO tree */
  navigateToIsoFile: (isoSourcePath: string) => void;
}

const FileTreeNavContext = createContext<FileTreeNav>({
  focusedPath: null,
  focusedVersion: 0,
  navigateToIsoFile: () => {},
});

interface V2VFileTreeProps {
  apiCalls: V2VApiCall[];
  fileCopies?: V2VFileCopy[];
  driveMappings?: V2VDriveMapping[];
  fstab?: V2VFstabEntry[];
  guestType?: string;
  /** Path to the VirtIO Win ISO (shown as label for virtio_win handle) */
  virtioWinIsoPath?: string | null;
  /** If true, guest device trees start expanded (but not the VirtIO ISO tree) */
  defaultExpandGuest?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

/** API function names that represent file/directory checks inside the guest. */
const FILE_CHECK_APIS = new Set([
  'is_file',
  'is_dir',
  'is_symlink',
  'is_blockdev',
  'is_chardev',
  'exists',
  'stat',
  'lstat',
]);

/** API function names that establish a mount context. */
const MOUNT_APIS = new Set(['mount', 'mount_ro', 'mount_options']);

/** Augeas API function names that operate on config files (with file paths). */
const AUGEAS_APIS = new Set([
  'aug_get', 'aug_set', 'aug_rm', 'aug_match',
  'aug_clear', 'aug_ls',
]);

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface FileCheck {
  api: string;
  result: string;
  lineNumber: number;
}

interface FileOp {
  type: 'copy' | 'augeas';
  origin: V2VFileCopy['origin'];
  source: string;
  sizeBytes: number | null;
  content: string | null;
  contentTruncated: boolean;
  lineNumber: number;
  /** Augeas operation type (only when type === 'augeas') */
  augOp?: 'get' | 'set' | 'rm' | 'match' | 'clear' | 'ls';
  /** Augeas key path within the file (e.g. "1/spec", "GRUB_CMDLINE_LINUX/value") */
  augKey?: string;
  /** Augeas value: result for get, second arg for set, match results for match */
  augValue?: string;
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  checks: FileCheck[];
  ops: FileOp[];
}

interface MountGroup {
  device: string;
  mountpoint: string;
  chrootPath: string;
  checks: V2VApiCall[];
}

interface TreeStats {
  totalEntries: number;
  found: number;
  notFound: number;
  copies: number;
  augeas: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Is this an Augeas data call (not error metadata)? */
function isAugeasDataCall(call: V2VApiCall): boolean {
  if (!AUGEAS_APIS.has(call.name)) return false;
  const arg = call.args;
  // Skip error/metadata paths like /augeas/files/.../error/
  if (arg.includes('/augeas/')) return false;
  // Only include paths operating on real files
  if (arg.includes('/files/')) return true;
  return false;
}

/**
 * Known config file leaf names (files without extensions that are valid config files).
 * Used when parsing Augeas paths to determine where the file path ends and the key begins.
 */
const KNOWN_CONFIG_LEAVES = new Set([
  'fstab', 'hostname', 'config', 'grub', 'passwd', 'group', 'shadow',
  'hosts', 'resolv.conf', 'nsswitch.conf', 'crypttab', 'mtab', 'shells',
  'services', 'protocols', 'exports', 'sudoers', 'crontab', 'profile',
  'environment', 'locale', 'timezone', 'adjtime',
]);

/** File extensions that indicate a config file in Augeas paths. */
const CONFIG_EXTENSIONS = /\.(conf|cfg|sh|ini|rules|repo|list|cnf|aug|mount|service|timer|socket|xml|json|yaml|yml|properties|env|d)$/;

/**
 * Parse an Augeas path like "/files/etc/fstab/1/spec" into
 * { filePath: "/etc/fstab", key: "1/spec" }.
 */
function parseAugeasPath(augPath: string): { filePath: string; key: string } | null {
  // Strip leading "/files" prefix
  let path = augPath;
  if (path.startsWith('/files')) path = path.slice(6); // "/files".length === 6
  if (!path.startsWith('/')) return null;

  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  // Walk segments to find the file boundary
  let fileEnd = segments.length; // default: entire path is the file
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // Numeric segments or array notation indicate we've passed the file boundary
    if (/^\d+$/.test(seg) || seg.includes('[')) {
      fileEnd = i;
      break;
    }
    // Segments with file extensions are the file
    if (CONFIG_EXTENSIONS.test(seg)) {
      fileEnd = i + 1;
      break;
    }
    // Known leaf names are the file
    if (KNOWN_CONFIG_LEAVES.has(seg)) {
      fileEnd = i + 1;
      break;
    }
    // UPPERCASE segments (like GRUB_CMDLINE_LINUX, SELINUX) are keys, not files
    if (seg === seg.toUpperCase() && seg.length > 1 && /^[A-Z_]+$/.test(seg)) {
      fileEnd = i;
      break;
    }
  }

  const filePath = '/' + segments.slice(0, fileEnd).join('/');
  const key = segments.slice(fileEnd).join('/');
  return { filePath, key };
}

function isCheckFound(check: FileCheck): boolean {
  if (check.api === 'stat' || check.api === 'lstat') {
    return check.result !== '' && check.result !== '0' && !check.result.startsWith('error');
  }
  return check.result === '1' || check.result === 'true';
}

function extractChrootPath(mountCall: V2VApiCall): string {
  for (const cmd of mountCall.guestCommands) {
    if (cmd.command === 'mount' && cmd.args.length > 0) {
      const raw = cmd.args[cmd.args.length - 1];
      return raw.replace(/\/+$/, '') || '/';
    }
  }
  return '';
}

// ────────────────────────────────────────────────────────────────────────────
// Mount-context grouping (for API-call checks)
// ────────────────────────────────────────────────────────────────────────────

function groupByMount(apiCalls: V2VApiCall[]): MountGroup[] {
  const groups: MountGroup[] = [];
  let currentDevice = '';
  let currentMountpoint = '';
  let currentChrootPath = '';
  let currentChecks: V2VApiCall[] = [];

  function flush() {
    if (currentChecks.length > 0 && currentDevice) {
      groups.push({
        device: currentDevice,
        mountpoint: currentMountpoint,
        chrootPath: currentChrootPath,
        checks: [...currentChecks],
      });
      currentChecks = [];
    }
  }

  for (const call of apiCalls) {
    if (MOUNT_APIS.has(call.name)) {
      let device = '';
      let mountpoint = '';
      const quoted = [...call.args.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      if (call.name === 'mount_options' && quoted.length >= 3) {
        device = quoted[1];
        mountpoint = quoted[2];
      } else if (quoted.length >= 2) {
        device = quoted[0];
        mountpoint = quoted[1];
      }
      if (device) {
        if (device !== currentDevice || mountpoint !== currentMountpoint) flush();
        currentDevice = device;
        currentMountpoint = mountpoint;
        currentChrootPath = extractChrootPath(call);
      }
    } else if (call.name === 'umount_all' || call.name === 'umount') {
      flush();
      currentDevice = '';
      currentMountpoint = '';
      currentChrootPath = '';
    } else if (FILE_CHECK_APIS.has(call.name) || isAugeasDataCall(call)) {
      currentChecks.push(call);
    }
  }
  flush();

  const merged = new Map<string, MountGroup>();
  for (const group of groups) {
    const key = `${group.device}::${group.mountpoint}`;
    const existing = merged.get(key);
    if (existing) {
      existing.checks.push(...group.checks);
    } else {
      merged.set(key, { ...group, checks: [...group.checks] });
    }
  }
  return [...merged.values()];
}

function groupNonGuestHandles(apiCalls: V2VApiCall[]): MountGroup[] {
  const byHandle = new Map<string, V2VApiCall[]>();
  for (const call of apiCalls) {
    if (call.handle && call.handle !== 'v2v' && FILE_CHECK_APIS.has(call.name)) {
      const arr = byHandle.get(call.handle) || [];
      arr.push(call);
      byHandle.set(call.handle, arr);
    }
  }
  const groups: MountGroup[] = [];
  for (const [handle, checks] of byHandle) {
    if (checks.length > 0) {
      groups.push({ device: handle, mountpoint: '/', chrootPath: '', checks });
    }
  }
  return groups;
}

// ────────────────────────────────────────────────────────────────────────────
// Tree building — merges both checks and file copies
// ────────────────────────────────────────────────────────────────────────────

function insertPath(root: TreeNode, rawPath: string): TreeNode {
  const segments = rawPath.replace(/^\/+/, '').split('/').filter(Boolean);
  let node = root;
  let currentPath = '/';
  for (const seg of segments) {
    currentPath = currentPath === '/' ? `/${seg}` : `${currentPath}/${seg}`;
    if (!node.children.has(seg)) {
      node.children.set(seg, { name: seg, path: currentPath, children: new Map(), checks: [], ops: [] });
    }
    node = node.children.get(seg)!;
  }
  return node;
}

function buildTree(checks: V2VApiCall[], fileCopies: V2VFileCopy[]): TreeNode {
  const root: TreeNode = { name: '/', path: '/', children: new Map(), checks: [], ops: [] };

  for (const call of checks) {
    // Handle Augeas calls separately — parse the /files/ path
    if (AUGEAS_APIS.has(call.name)) {
      const pathMatch = call.args.match(/^"([^"]+)"/);
      if (!pathMatch) continue;
      const parsed = parseAugeasPath(pathMatch[1]);
      if (!parsed) continue;

      const augOpType = call.name.replace('aug_', '') as FileOp['augOp'];

      // For aug_set, the value is the second quoted arg; aug_clear has no value
      let augValue = call.result;
      if (augOpType === 'set') {
        const allQuoted = [...call.args.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
        augValue = allQuoted.length >= 2 ? allQuoted[1] : '';
      } else if (augOpType === 'clear') {
        augValue = '';
      }

      const node = insertPath(root, parsed.filePath);
      node.ops.push({
        type: 'augeas',
        augOp: augOpType,
        augKey: parsed.key,
        augValue,
        lineNumber: call.lineNumber,
        // Copy fields default values (not used for augeas)
        origin: 'guest',
        source: '',
        sizeBytes: null,
        content: null,
        contentTruncated: false,
      });
      continue;
    }

    // Regular file check
    const pathMatch = call.args.match(/^"([^"]+)"/);
    if (!pathMatch) continue;
    const node = insertPath(root, pathMatch[1]);
    node.checks.push({ api: call.name, result: call.result, lineNumber: call.lineNumber });
  }

  for (const fc of fileCopies) {
    const node = insertPath(root, fc.destination);
    node.ops.push({
      type: 'copy',
      origin: fc.origin,
      source: fc.source,
      sizeBytes: fc.sizeBytes,
      content: fc.content,
      contentTruncated: fc.contentTruncated,
      lineNumber: fc.lineNumber,
    });
  }

  return root;
}

function countStats(node: TreeNode): TreeStats {
  let totalEntries = 0;
  let found = 0;
  let notFound = 0;
  let copies = 0;
  let augeas = 0;

  const isLeaf = node.children.size === 0;
  if (isLeaf && (node.checks.length > 0 || node.ops.length > 0)) {
    totalEntries = 1;
    const copyOps = node.ops.filter((op) => op.type === 'copy');
    const augOps = node.ops.filter((op) => op.type === 'augeas');
    if (copyOps.length > 0) copies = 1;
    if (augOps.length > 0) augeas = augOps.length;
    if (node.checks.length > 0) {
      const anyFound = node.checks.some(isCheckFound);
      if (anyFound) found = 1;
      else notFound = 1;
    }
  }

  for (const child of node.children.values()) {
    const sub = countStats(child);
    totalEntries += sub.totalEntries;
    found += sub.found;
    notFound += sub.notFound;
    copies += sub.copies;
    augeas += sub.augeas;
  }

  return { totalEntries, found, notFound, copies, augeas };
}

function isDirectory(node: TreeNode): boolean {
  return node.children.size > 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Label helpers
// ────────────────────────────────────────────────────────────────────────────

function buildDeviceLabelMap(
  driveMappings?: V2VDriveMapping[],
  fstab?: V2VFstabEntry[],
): Map<string, string> {
  const map = new Map<string, string>();
  if (driveMappings) {
    for (const m of driveMappings) map.set(m.device, `${m.letter}:`);
  }
  if (fstab) {
    for (const entry of fstab) {
      if (!map.has(entry.device) && entry.mountpoint !== 'none') map.set(entry.device, entry.mountpoint);
    }
  }
  return map;
}

function getDeviceDisplayInfo(
  device: string,
  labelMap: Map<string, string>,
  guestType?: string,
): { primary: string; secondary: string; icon: string } {
  const label = labelMap.get(device);
  if (label) return { primary: label, secondary: device, icon: '💾' };
  if (guestType === 'windows') return { primary: 'Virtio-Win ISO', secondary: device, icon: '💿' };
  return { primary: device, secondary: '', icon: '💾' };
}

function getHandleDisplayInfo(
  handle: string,
  virtioWinIsoPath?: string | null,
): { primary: string; secondary: string; icon: string } {
  if (handle === 'virtio_win') {
    return { primary: 'VirtIO Win ISO', secondary: virtioWinIsoPath || '', icon: '💿' };
  }
  return { primary: handle, secondary: '', icon: '💾' };
}

// ────────────────────────────────────────────────────────────────────────────
// Deduplicate file copies
// ────────────────────────────────────────────────────────────────────────────

function dedupeFileCopies(fileCopies: V2VFileCopy[]): V2VFileCopy[] {
  const seen = new Set<string>();
  const result: V2VFileCopy[] = [];
  for (const fc of fileCopies) {
    const key = `${fc.source}→${fc.destination}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(fc);
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Main component
// ────────────────────────────────────────────────────────────────────────────

export function V2VFileTree({
  apiCalls,
  fileCopies: rawFileCopies,
  driveMappings,
  fstab,
  guestType,
  virtioWinIsoPath,
  defaultExpandGuest = false,
}: V2VFileTreeProps) {
  const fileCopies = useMemo(() => dedupeFileCopies(rawFileCopies || []), [rawFileCopies]);

  // Cross-tree navigation state: clicking a VirtIO source link focuses the ISO tree
  const [focusedIsoPath, setFocusedIsoPath] = useState<string | null>(null);
  const [focusedIsoVersion, setFocusedIsoVersion] = useState(0);

  const navigateToIsoFile = useCallback((isoSourcePath: string) => {
    // Clean path: ///Balloon/2k19/amd64/balloon.inf → /Balloon/2k19/amd64/balloon.inf
    const cleanPath = '/' + isoSourcePath.replace(/^\/+/, '');
    setFocusedIsoPath(cleanPath);
    setFocusedIsoVersion((v) => v + 1);
  }, []);

  const navCtx = useMemo<FileTreeNav>(
    () => ({ focusedPath: focusedIsoPath, focusedVersion: focusedIsoVersion, navigateToIsoFile }),
    [focusedIsoPath, focusedIsoVersion, navigateToIsoFile],
  );

  // Guest filesystem API checks (v2v handle)
  const guestCalls = useMemo(
    () => apiCalls.filter((c) => c.handle === 'v2v' || c.handle === ''),
    [apiCalls],
  );
  const mountGroups = useMemo(() => groupByMount(guestCalls), [guestCalls]);

  // Non-guest handle API checks (e.g. virtio_win ISO)
  const handleGroups = useMemo(() => groupNonGuestHandles(apiCalls), [apiCalls]);

  // File copies destined for the guest (v2v write/upload)
  const guestFileCopies = useMemo(
    () => fileCopies.filter((fc) => fc.origin !== 'virtio_win' || fc.destination.startsWith('/')),
    [fileCopies],
  );

  const deviceLabelMap = useMemo(
    () => buildDeviceLabelMap(driveMappings, fstab),
    [driveMappings, fstab],
  );

  // Figure out which mount group to attach file copies to.
  // Most copies go to the root device. We'll attach them all to the first (root) mount group.
  // If no mount groups exist, create a synthetic one for the root device.
  const enrichedMountGroups = useMemo(() => {
    if (guestFileCopies.length === 0) return mountGroups;

    // Find the root device from the first mount group or guest info
    const rootGroup = mountGroups.find((g) => g.mountpoint === '/') || mountGroups[0];
    if (!rootGroup) {
      // No mount groups at all — create a synthetic one if we have file copies
      return [
        ...mountGroups,
        { device: 'Guest', mountpoint: '/', chrootPath: '', checks: [] as V2VApiCall[] },
      ];
    }
    return mountGroups;
  }, [mountGroups, guestFileCopies.length]);

  const { totalFileChecks, totalAugeasOps } = useMemo(() => {
    let fileChecks = 0;
    let augOps = 0;
    const allGroups = [...enrichedMountGroups, ...handleGroups];
    for (const g of allGroups) {
      for (const c of g.checks) {
        if (AUGEAS_APIS.has(c.name)) augOps++;
        else fileChecks++;
      }
    }
    return { totalFileChecks: fileChecks, totalAugeasOps: augOps };
  }, [enrichedMountGroups, handleGroups]);

  const totalDevices = enrichedMountGroups.length + handleGroups.length;
  const totalOps = totalFileChecks + guestFileCopies.length + totalAugeasOps;

  if (totalOps === 0) return null;

  return (
    <FileTreeNavContext.Provider value={navCtx}>
      <div className="space-y-4">
        {/* Summary */}
        <div className="flex flex-wrap gap-3 text-xs text-slate-500 dark:text-gray-400">
          <span>
            {totalOps.toLocaleString()} file operations across {totalDevices} device
            {totalDevices !== 1 ? 's' : ''}
          </span>
          {totalFileChecks > 0 && (
            <span className="text-indigo-500 dark:text-indigo-400">
              {totalFileChecks.toLocaleString()} checks
            </span>
          )}
          {guestFileCopies.length > 0 && (
            <span className="text-blue-500 dark:text-blue-400">
              {guestFileCopies.length.toLocaleString()} copies
            </span>
          )}
          {totalAugeasOps > 0 && (
            <span className="text-violet-500 dark:text-violet-400">
              {totalAugeasOps.toLocaleString()} config ops
            </span>
          )}
        </div>

        {/* One tree per mounted guest device */}
        {enrichedMountGroups.map((group) => {
          const display = getDeviceDisplayInfo(group.device, deviceLabelMap, guestType);
          // Attach file copies to the root (/) mount group
          const copies = group.mountpoint === '/' ? guestFileCopies : [];
          return (
            <DeviceTree
              key={`${group.device}::${group.mountpoint}`}
              checks={group.checks}
              fileCopies={copies}
              primaryLabel={display.primary}
              secondaryLabel={display.secondary}
              icon={display.icon}
              defaultExpanded={defaultExpandGuest}
            />
          );
        })}

        {/* One tree per non-guest handle (e.g. virtio_win ISO) */}
        {handleGroups.map((group) => {
          const display = getHandleDisplayInfo(group.device, virtioWinIsoPath);
          return (
            <DeviceTree
              key={`handle::${group.device}`}
              checks={group.checks}
              fileCopies={[]}
              primaryLabel={display.primary}
              secondaryLabel={display.secondary}
              icon={display.icon}
              isIsoTree
            />
          );
        })}
      </div>
    </FileTreeNavContext.Provider>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// DeviceTree
// ────────────────────────────────────────────────────────────────────────────

function DeviceTree({
  checks,
  fileCopies,
  primaryLabel,
  secondaryLabel,
  icon = '💾',
  isIsoTree = false,
  defaultExpanded = false,
}: {
  checks: V2VApiCall[];
  fileCopies: V2VFileCopy[];
  primaryLabel: string;
  secondaryLabel: string;
  icon?: string;
  /** If true, this tree participates in cross-tree ISO navigation */
  isIsoTree?: boolean;
  /** If true, the tree starts expanded */
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const tree = useMemo(() => buildTree(checks, fileCopies), [checks, fileCopies]);
  const stats = useMemo(() => countStats(tree), [tree]);
  const { focusedPath, focusedVersion } = useContext(FileTreeNavContext);

  // Auto-expand this device tree when a focused ISO path targets it
  useEffect(() => {
    if (isIsoTree && focusedPath) {
      setExpanded(true);
    }
  }, [isIsoTree, focusedPath, focusedVersion]);

  if (stats.totalEntries === 0) return null;

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-3 px-4 py-2.5 bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-left"
      >
        <span className="text-[10px] text-indigo-500 dark:text-indigo-400 flex-shrink-0">
          {expanded ? '▼' : '▶'}
        </span>
        <span className="text-sm">{icon}</span>
        <span className="text-xs font-semibold text-slate-800 dark:text-gray-200">
          {primaryLabel}
        </span>
        {secondaryLabel && (
          <span className="text-[10px] font-mono text-slate-400 dark:text-gray-500">
            {secondaryLabel}
          </span>
        )}

        <span className="ml-auto flex items-center gap-3 text-[10px]">
          <span className="text-slate-500 dark:text-gray-400">
            {stats.totalEntries.toLocaleString()} {stats.totalEntries === 1 ? 'entry' : 'entries'}
          </span>
          {stats.found > 0 && (
            <span className="text-green-600 dark:text-green-400">
              {stats.found.toLocaleString()} found
            </span>
          )}
          {stats.notFound > 0 && (
            <span className="text-red-500 dark:text-red-400">
              {stats.notFound.toLocaleString()} missing
            </span>
          )}
          {stats.copies > 0 && (
            <span className="text-blue-500 dark:text-blue-400">
              {stats.copies.toLocaleString()} copied
            </span>
          )}
          {stats.augeas > 0 && (
            <span className="text-violet-500 dark:text-violet-400">
              {stats.augeas.toLocaleString()} config ops
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="max-h-[500px] overflow-y-auto font-mono text-[11px] py-1 px-2">
          {[...tree.children.values()]
            .sort((a, b) => {
              const aDir = isDirectory(a);
              const bDir = isDirectory(b);
              if (aDir !== bDir) return aDir ? -1 : 1;
              return a.name.localeCompare(b.name);
            })
            .map((child) => (
              <TreeNodeRow key={child.path} node={child} depth={0} />
            ))}
          {tree.children.size === 0 && (
            <div className="text-[11px] text-slate-400 dark:text-gray-500 italic px-2 py-2">
              No file tree entries.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// TreeNodeRow
// ────────────────────────────────────────────────────────────────────────────

function TreeNodeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const isDir = isDirectory(node);
  const [expanded, setExpanded] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const stats = useMemo(() => countStats(node), [node]);
  const nodeRef = useRef<HTMLDivElement>(null);
  const { focusedPath, focusedVersion } = useContext(FileTreeNavContext);

  // Is this node on the path to the focused file?
  const isOnFocusedPath =
    focusedPath !== null &&
    isDir &&
    (focusedPath.startsWith(node.path + '/') || focusedPath === node.path);

  // Is this node the exact focused target?
  const isFocusedTarget = focusedPath !== null && focusedPath === node.path && !isDir;

  // Auto-expand directory nodes along the focused path
  useEffect(() => {
    if (isOnFocusedPath) setExpanded(true);
  }, [isOnFocusedPath, focusedVersion]);

  // Scroll the focused leaf into view
  useEffect(() => {
    if (isFocusedTarget && nodeRef.current) {
      requestAnimationFrame(() => {
        nodeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }, [isFocusedTarget, focusedVersion]);

  const toggle = useCallback(() => setExpanded((prev) => !prev), []);

  const hasChecks = node.checks.length > 0;
  const hasOps = node.ops.length > 0;
  const copyOps = node.ops.filter((op) => op.type === 'copy');
  const augOps = node.ops.filter((op) => op.type === 'augeas');
  const hasCopyOps = copyOps.length > 0;
  const hasAugOps = augOps.length > 0;
  const isFound = node.checks.some(isCheckFound);
  const scriptOp = copyOps.find((op) => op.content !== null);
  // Any copied file or augeas config file is expandable
  const isExpandableLeaf = !isDir && (hasCopyOps || hasAugOps);

  const sortedChildren = useMemo(() => {
    return [...node.children.values()].sort((a, b) => {
      const aDir = isDirectory(a);
      const bDir = isDirectory(b);
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [node]);

  // Determine leaf icon and status
  let leafIcon: React.ReactNode = null;
  let statusBadge: React.ReactNode = null;

  if (!isDir) {
    if (hasAugOps && !hasCopyOps && !hasChecks) {
      // Pure augeas config file node
      leafIcon = <span className="text-violet-500">⚙</span>;
    } else if (hasOps && hasChecks) {
      leafIcon = <span className="text-blue-500">📄</span>;
      statusBadge = (
        <span className={`text-[9px] flex-shrink-0 ${isFound ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
          {isFound ? '✓' : '✗'}
        </span>
      );
    } else if (hasOps) {
      leafIcon = <span className="text-blue-500">📄</span>;
    } else if (hasChecks) {
      leafIcon = (
        <span className={isFound ? 'text-green-500' : 'text-red-400 opacity-50'}>
          📄
        </span>
      );
      statusBadge = (
        <span className={`text-[9px] flex-shrink-0 ${isFound ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
          {isFound ? '✓' : '✗'}
        </span>
      );
    }
  }

  return (
    <div ref={nodeRef}>
      <div
        role={isDir || isExpandableLeaf ? 'button' : undefined}
        tabIndex={isDir || isExpandableLeaf ? 0 : undefined}
        aria-expanded={isDir ? expanded : isExpandableLeaf ? showDetails : undefined}
        onClick={isDir ? toggle : isExpandableLeaf ? () => setShowDetails(!showDetails) : undefined}
        onKeyDown={isDir || isExpandableLeaf ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (isDir) { toggle(); } else { setShowDetails((prev) => !prev); } } } : undefined}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        className={`
          flex items-center gap-1.5 py-0.5 rounded transition-colors duration-700
          ${isDir || isExpandableLeaf ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800' : ''}
          ${isFocusedTarget ? 'bg-purple-100 dark:bg-purple-900/40 ring-1 ring-purple-400 dark:ring-purple-600' : ''}
        `}
      >
        {isDir ? (
          <span className="text-[9px] text-indigo-500 dark:text-indigo-400 w-3 text-center flex-shrink-0">
            {expanded ? '▼' : '▶'}
          </span>
        ) : isExpandableLeaf ? (
          <span className="text-[9px] text-slate-400 w-3 text-center flex-shrink-0">
            {showDetails ? '▼' : '▶'}
          </span>
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}

        <span className="flex-shrink-0 text-[10px]">
          {isDir ? (
            <span className="text-amber-500 dark:text-amber-400">
              {expanded ? '📂' : '📁'}
            </span>
          ) : (
            leafIcon
          )}
        </span>

        <span
          className={`flex-shrink-0 ${
            isDir
              ? 'text-slate-800 dark:text-gray-200 font-medium'
              : hasChecks && !isFound && !hasOps
                ? 'text-slate-400 dark:text-gray-600 line-through'
                : 'text-slate-700 dark:text-gray-300'
          }`}
        >
          {node.name}
          {isDir && '/'}
        </span>

        {/* Status badge for checks */}
        {!isDir && statusBadge}

        {/* Check API name if not is_file */}
        {!isDir && hasChecks && node.checks.some((c) => c.api !== 'is_file') && (
          <span className="text-[9px] text-slate-400 dark:text-gray-600">
            {node.checks.find((c) => c.api !== 'is_file')?.api}
          </span>
        )}

        {/* Origin badges for file copies */}
        {!isDir && hasCopyOps && copyOps.map((op, i) => (
          <OriginBadge key={i} origin={op.origin} />
        ))}

        {/* Augeas operation count badges */}
        {!isDir && hasAugOps && (() => {
          const gets = augOps.filter((o) => o.augOp === 'get').length;
          const sets = augOps.filter((o) => o.augOp === 'set').length;
          const rms = augOps.filter((o) => o.augOp === 'rm').length;
          const matches = augOps.filter((o) => o.augOp === 'match').length;
          const clears = augOps.filter((o) => o.augOp === 'clear').length;
          const lss = augOps.filter((o) => o.augOp === 'ls').length;
          return (
            <>
              {gets > 0 && <span className="text-[8px] px-1 py-0 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 flex-shrink-0">{gets} GET</span>}
              {sets > 0 && <span className="text-[8px] px-1 py-0 rounded bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 flex-shrink-0">{sets} SET</span>}
              {clears > 0 && <span className="text-[8px] px-1 py-0 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 flex-shrink-0">{clears} CLEAR</span>}
              {rms > 0 && <span className="text-[8px] px-1 py-0 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 flex-shrink-0">{rms} RM</span>}
              {matches > 0 && <span className="text-[8px] px-1 py-0 rounded bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400 flex-shrink-0">{matches} MATCH</span>}
              {lss > 0 && <span className="text-[8px] px-1 py-0 rounded bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400 flex-shrink-0">{lss} LS</span>}
            </>
          );
        })()}

        {/* File size */}
        {!isDir && hasCopyOps && (() => {
          const sz = copyOps.find((op) => op.sizeBytes !== null)?.sizeBytes;
          return sz != null ? (
            <span className="text-[9px] text-green-600 dark:text-green-400 flex-shrink-0">
              {formatBytes(sz)}
            </span>
          ) : null;
        })()}

        {/* Line link */}
        {!isDir && (hasChecks || hasOps) && (
          <LineLink line={(node.checks[0] || node.ops[0])?.lineNumber ?? 0} />
        )}

        {/* Directory stats */}
        {isDir && (
          <span className="text-[9px] text-slate-400 dark:text-gray-500 ml-1">
            {stats.totalEntries} {stats.totalEntries !== 1 ? 'entries' : 'entry'}
            {stats.found > 0 && (
              <span className="text-green-600 dark:text-green-400 ml-1">
                {stats.found} found
              </span>
            )}
            {stats.notFound > 0 && (
              <span className="text-red-500 dark:text-red-400 ml-1">
                {stats.notFound} missing
              </span>
            )}
            {stats.copies > 0 && (
              <span className="text-blue-500 dark:text-blue-400 ml-1">
                {stats.copies} copied
              </span>
            )}
            {stats.augeas > 0 && (
              <span className="text-violet-500 dark:text-violet-400 ml-1">
                {stats.augeas} config ops
              </span>
            )}
          </span>
        )}
      </div>

      {/* Expandable details for copied files and augeas ops */}
      {!isDir && showDetails && (hasCopyOps || hasAugOps) && (
        <div style={{ paddingLeft: `${depth * 16 + 24}px` }} className="py-1 pr-2">
          <div className="rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden text-[11px]">
            {/* Source info for each copy operation */}
            {copyOps.map((op, i) => (
              <CopySourceRow key={`copy-${i}`} op={op} />
            ))}

            {/* Script content (if any) */}
            {scriptOp && (
              <>
                <div className="flex items-center justify-between px-3 py-1.5 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-700">
                  <span className="font-medium text-slate-600 dark:text-gray-300">
                    Content
                  </span>
                  {scriptOp.contentTruncated && (
                    <span className="text-[10px] text-amber-600 dark:text-amber-400 italic">
                      truncated
                      {scriptOp.sizeBytes !== null && ` (full: ${formatBytes(scriptOp.sizeBytes)})`}
                    </span>
                  )}
                </div>
                <pre className="px-3 py-2 leading-relaxed font-mono text-slate-800 dark:text-gray-200 bg-white dark:bg-slate-900 overflow-x-auto max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words">
                  {scriptOp.content}
                </pre>
              </>
            )}

            {/* Augeas operations */}
            {hasAugOps && (
              <div className={hasCopyOps || scriptOp ? 'border-t border-slate-200 dark:border-slate-700' : ''}>
                {augOps.map((op, i) => (
                  <AugeasOpRow key={`aug-${i}`} op={op} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Directory children */}
      {isDir && expanded && (
        <div>
          {sortedChildren.map((child) => (
            <TreeNodeRow key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Copy source row — shows where a file was copied from
// ────────────────────────────────────────────────────────────────────────────

function CopySourceRow({ op }: { op: FileOp }) {
  const { navigateToIsoFile } = useContext(FileTreeNavContext);

  const isVirtioWin = op.origin === 'virtio_win';
  // VirtIO Win ISO paths look like ///Balloon/2k19/amd64/balloon.sys
  // Clean it for display
  const displaySource = isVirtioWin
    ? op.source.replace(/^\/\/\//, 'ISO: /')
    : op.source;

  return (
    <div className="flex items-baseline gap-2 px-3 py-1.5 bg-slate-50 dark:bg-slate-800/50">
      <span className="text-slate-400 dark:text-gray-500 flex-shrink-0">from</span>
      <OriginBadge origin={op.origin} />
      {isVirtioWin ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            navigateToIsoFile(op.source);
          }}
          className="font-mono text-purple-600 dark:text-purple-400 hover:text-purple-800 dark:hover:text-purple-300 hover:underline cursor-pointer truncate"
          title={`Navigate to ${op.source.replace(/^\/+/, '')} in VirtIO Win ISO tree`}
        >
          {displaySource}
        </button>
      ) : (
        <span className="font-mono text-slate-600 dark:text-gray-300 truncate" title={op.source}>
          {displaySource}
        </span>
      )}
      {op.sizeBytes !== null && (
        <span className="text-green-600 dark:text-green-400 flex-shrink-0 ml-auto">
          {formatBytes(op.sizeBytes)}
        </span>
      )}
      <span className="flex-shrink-0">
        <LineLink line={op.lineNumber} />
      </span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Augeas operation row — shows a single augeas get/set/rm/match
// ────────────────────────────────────────────────────────────────────────────

const AUGEAS_OP_STYLES: Record<string, string> = {
  get: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
  set: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400',
  rm: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
  match: 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400',
  clear: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
  ls: 'bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400',
};

function AugeasOpRow({ op }: { op: FileOp }) {
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

// ────────────────────────────────────────────────────────────────────────────
// Origin badge
// ────────────────────────────────────────────────────────────────────────────

