/**
 * V2V path classification for archive files.
 *
 * Extracted from archiveProcessor.ts for testability.
 * Classifies archive paths as V2V log files based on path patterns.
 */

/**
 * Path pattern that identifies virt-v2v log files inside a must-gather.
 *
 * Matches paths like:
 *   namespaces/.../pods/planName-vm-NNNN-suffix/virt-v2v/.../logs/current.log
 *   namespaces/.../logs/planName-vm-NNNN-suffix/current.log
 *
 * Captures: [1] = target namespace, [2] = plan name, [3] = VM id (numeric part)
 */
export const V2V_PATH_RE = /namespaces\/([^/]+)\/(?:pods|logs)\/(.+)-vm-(\d+)-[a-z0-9][-a-z0-9]*\//;

/** Extensions that are never V2V log files, even when found under a V2V pod path. */
export const NON_LOG_EXTENSIONS = ['.yaml', '.yml', '.json', '.xml', '.html', '.css', '.js', '.png', '.jpg', '.gif', '.pdf'];

/**
 * Check whether a file path looks like a virt-v2v log based on the archive path.
 * This catches V2V logs even when the first few KB of content don't contain
 * recognisable V2V markers (e.g. heavy container-runtime timestamp prefixes).
 *
 * Files with known non-log extensions (e.g. `.yaml`) are excluded — pod
 * directories often contain resource YAML alongside the actual logs.
 */
export function isV2VLogByPath(path: string): boolean {
  const lower = path.toLowerCase();

  // Never classify non-log files as V2V logs by path alone
  if (NON_LOG_EXTENSIONS.some((ext) => lower.endsWith(ext))) return false;

  if (V2V_PATH_RE.test(path)) return true;
  // Also match if the path literally contains "virt-v2v" as a directory
  return lower.includes('/virt-v2v/') || lower.includes('/virt-v2v-inspector/');
}

/**
 * Extract plan name and VM ID from a V2V archive path.
 *
 * Examples:
 *   `wmsql2-dev-take2-vm-5451-h2fmt` → planName=`wmsql2-dev-take2`, vmId=`vm-5451`
 *   `ccm02220-vm-10975-5kxtj` → planName=`ccm02220`, vmId=`vm-10975`
 */
export function extractV2VPathMeta(path: string): { planName?: string; vmId?: string } {
  const match = V2V_PATH_RE.exec(path);
  if (!match) return {};
  return {
    planName: match[2],
    vmId: `vm-${match[3]}`,
  };
}
