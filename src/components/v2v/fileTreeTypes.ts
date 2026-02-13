/**
 * Shared types, interfaces, constants, and context for the V2V file tree components.
 */
import { createContext } from 'react';
import type { V2VApiCall, V2VFileCopy } from '../../types/v2v';

// ────────────────────────────────────────────────────────────────────────────
// Cross-tree navigation context
// ────────────────────────────────────────────────────────────────────────────

export interface FileTreeNav {
  /** Path currently focused in the ISO tree (e.g. /Balloon/2k19/amd64/balloon.inf) */
  focusedPath: string | null;
  /** Monotonically increasing — forces re-triggers even when re-clicking the same path */
  focusedVersion: number;
  /** Called by CopySourceRow to navigate into the ISO tree */
  navigateToIsoFile: (isoSourcePath: string) => void;
}

export const FileTreeNavContext = createContext<FileTreeNav>({
  focusedPath: null,
  focusedVersion: 0,
  navigateToIsoFile: () => {},
});

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

/** API function names that represent file/directory checks inside the guest. */
export const FILE_CHECK_APIS = new Set([
  'is_file',
  'is_dir',
  'is_symlink',
  'is_blockdev',
  'is_chardev',
  'exists',
  'stat',
  'lstat',
]);

/** Broader set of file-related APIs shown in per-stage file operation trees. */
export const STAGE_FILE_OPS = new Set([
  ...FILE_CHECK_APIS,
  'download', 'upload', 'copy_in', 'copy_out',
  'read_file', 'read_lines', 'cat',
  'write', 'write_file', 'write_append',
  'mkdir', 'mkdir_p',
  'rm', 'rm_rf', 'rmdir',
  'chmod', 'chown',
  'ln_sf', 'ln_s', 'link',
  'cp', 'cp_a', 'mv', 'rename',
]);

/** API function names that establish a mount context. */
export const MOUNT_APIS = new Set(['mount', 'mount_ro', 'mount_options']);

/** Augeas API function names that operate on config files (with file paths). */
export const AUGEAS_APIS = new Set([
  'aug_get', 'aug_set', 'aug_rm', 'aug_match',
  'aug_clear', 'aug_ls',
]);

/**
 * Known config file leaf names (files without extensions that are valid config files).
 * Used when parsing Augeas paths to determine where the file path ends and the key begins.
 */
export const KNOWN_CONFIG_LEAVES = new Set([
  'fstab', 'hostname', 'config', 'grub', 'passwd', 'group', 'shadow',
  'hosts', 'resolv.conf', 'nsswitch.conf', 'crypttab', 'mtab', 'shells',
  'services', 'protocols', 'exports', 'sudoers', 'crontab', 'profile',
  'environment', 'locale', 'timezone', 'adjtime',
]);

/** File extensions that indicate a config file in Augeas paths. */
export const CONFIG_EXTENSIONS = /\.(conf|cfg|sh|ini|rules|repo|list|cnf|aug|mount|service|timer|socket|xml|json|yaml|yml|properties|env|d)$/;

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface FileCheck {
  api: string;
  result: string;
  lineNumber: number;
}

export interface FileOp {
  type: 'copy' | 'augeas' | 'relabel';
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
  /** SELinux context before relabel (only when type === 'relabel') */
  fromContext?: string;
  /** SELinux context after relabel (only when type === 'relabel') */
  toContext?: string;
}

export interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  checks: FileCheck[];
  ops: FileOp[];
}

export interface MountGroup {
  device: string;
  mountpoint: string;
  chrootPath: string;
  checks: V2VApiCall[];
  /** Line number of the mount API call (for navigation) */
  mountLineNumber?: number;
  /** Line number where this mount cycle ends (umount or next mount) */
  endLineNumber?: number;
  /** 1-based pass number when a device is mounted multiple times */
  pass: number;
}

export interface MergedDeviceGroup {
  device: string;
  mountpoint: string;
  passes: MountGroup[];
  allChecks: V2VApiCall[];
  firstMountLineNumber?: number;
}

export interface TreeStats {
  totalEntries: number;
  found: number;
  notFound: number;
  copies: number;
  scripts: number;
  augeas: number;
  relabels: number;
}
