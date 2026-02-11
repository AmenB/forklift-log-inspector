/**
 * NBDKIT log parsing for virt-v2v logs.
 * Extracts connection info, plugin/filter registration, and disk metadata.
 */

import type { NbdkitConnection } from '../../types/v2v';

/** nbdkit socket path */
export const NBDKIT_SOCKET_RE = /--unix['\s]+([^\s']+)/;

/** nbdkit NBD URI */
export const NBDKIT_URI_RE = /NBD URI:\s*(\S+)/;

/** nbdkit plugin registration */
export const NBDKIT_PLUGIN_RE = /registered plugin\s+\S+\s+\(name\s+(\w+)\)/;

/** nbdkit filter registration */
export const NBDKIT_FILTER_RE = /registered filter\s+\S+\s+\(name\s+(\w+)\)/;

/** nbdkit file= config */
export const NBDKIT_FILE_RE = /config key=file, value=(.+)/;

/** nbdkit config key=server, value=10.6.46.159 */
export const NBDKIT_SERVER_RE = /config key=server, value=(\S+)/;

/** nbdkit config key=vm, value=moref=vm-152 */
export const NBDKIT_VM_RE = /config key=vm, value=moref=(\S+)/;

/** nbdkit transport mode: nbdssl */
export const NBDKIT_TRANSPORT_RE = /transport mode:\s*(\w+)/;

/** nbdkit: vddk[N]: debug: cow: underlying file size: NNNN */
export const COW_FILE_SIZE_RE = /cow:\s+underlying file size:\s+(\d+)/;

export function finalizeNbdkit(
  nbdkit: Partial<NbdkitConnection>,
  map: Map<string, NbdkitConnection>,
  endLine: number,
): void {
  const id = nbdkit.socketPath || `nbdkit-${map.size}`;
  if (!map.has(id)) {
    map.set(id, {
      id,
      socketPath: nbdkit.socketPath || '',
      uri: nbdkit.uri || '',
      plugin: nbdkit.plugin || '',
      filters: nbdkit.filters || [],
      diskFile: nbdkit.diskFile || '',
      startLine: nbdkit.startLine || endLine,
      endLine,
      logLines: nbdkit.logLines || [],
      server: nbdkit.server,
      vmMoref: nbdkit.vmMoref,
      transportMode: nbdkit.transportMode,
      backingSize: nbdkit.backingSize,
    });
  }
}
