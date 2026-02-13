import { describe, it, expect } from 'vitest';
import {
  NBDKIT_SOCKET_RE,
  NBDKIT_URI_RE,
  NBDKIT_PLUGIN_RE,
  NBDKIT_FILTER_RE,
  NBDKIT_FILE_RE,
  NBDKIT_SERVER_RE,
  NBDKIT_VM_RE,
  NBDKIT_TRANSPORT_RE,
  COW_FILE_SIZE_RE,
  finalizeNbdkit,
} from '../v2v/nbdkitParser';
import type { NbdkitConnection } from '../../types/v2v';

// ────────────────────────────────────────────────────────────────────────────
// NBDKIT_SOCKET_RE
// ────────────────────────────────────────────────────────────────────────────

describe('NBDKIT_SOCKET_RE', () => {
  it('matches --unix socket path', () => {
    const m = 'nbdkit --unix /tmp/nbdkit.sock vddk'.match(NBDKIT_SOCKET_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('/tmp/nbdkit.sock');
  });

  it('matches --unix with single quotes', () => {
    const m = "nbdkit --unix '/var/run/nbd.sock' vddk".match(NBDKIT_SOCKET_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('/var/run/nbd.sock');
  });

  it('does not match line without --unix', () => {
    expect('nbdkit vddk file=disk.vmdk'.match(NBDKIT_SOCKET_RE)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NBDKIT_URI_RE
// ────────────────────────────────────────────────────────────────────────────

describe('NBDKIT_URI_RE', () => {
  it('matches NBD URI line', () => {
    const m = 'NBD URI: nbd+unix:///?socket=/tmp/nbd.sock'.match(NBDKIT_URI_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('nbd+unix:///?socket=/tmp/nbd.sock');
  });

  it('matches nbdssl URI', () => {
    const m = 'NBD URI: nbdssl://10.0.0.1:10809'.match(NBDKIT_URI_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('nbdssl://10.0.0.1:10809');
  });

  it('does not match line without NBD URI', () => {
    expect('nbdkit: debug: connecting'.match(NBDKIT_URI_RE)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NBDKIT_PLUGIN_RE
// ────────────────────────────────────────────────────────────────────────────

describe('NBDKIT_PLUGIN_RE', () => {
  it('matches plugin registration', () => {
    const m =
      'registered plugin /usr/lib64/nbdkit/plugins/nbdkit-vddk-plugin.so (name vddk)'.match(
        NBDKIT_PLUGIN_RE,
      );
    expect(m).not.toBeNull();
    expect(m![1]).toBe('vddk');
  });

  it('matches file plugin', () => {
    const m =
      'registered plugin /usr/lib64/nbdkit/plugins/nbdkit-file-plugin.so (name file)'.match(
        NBDKIT_PLUGIN_RE,
      );
    expect(m).not.toBeNull();
    expect(m![1]).toBe('file');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NBDKIT_FILTER_RE
// ────────────────────────────────────────────────────────────────────────────

describe('NBDKIT_FILTER_RE', () => {
  it('matches filter registration', () => {
    const m =
      'registered filter /usr/lib64/nbdkit/filters/nbdkit-cow-filter.so (name cow)'.match(
        NBDKIT_FILTER_RE,
      );
    expect(m).not.toBeNull();
    expect(m![1]).toBe('cow');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NBDKIT_FILE_RE
// ────────────────────────────────────────────────────────────────────────────

describe('NBDKIT_FILE_RE', () => {
  it('matches config key=file', () => {
    const m = 'config key=file, value=/path/to/disk.vmdk'.match(NBDKIT_FILE_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('/path/to/disk.vmdk');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NBDKIT_SERVER_RE
// ────────────────────────────────────────────────────────────────────────────

describe('NBDKIT_SERVER_RE', () => {
  it('matches config key=server', () => {
    const m = 'config key=server, value=10.6.46.159'.match(NBDKIT_SERVER_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('10.6.46.159');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NBDKIT_VM_RE
// ────────────────────────────────────────────────────────────────────────────

describe('NBDKIT_VM_RE', () => {
  it('matches config key=vm with moref', () => {
    const m = 'config key=vm, value=moref=vm-152'.match(NBDKIT_VM_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('vm-152');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NBDKIT_TRANSPORT_RE
// ────────────────────────────────────────────────────────────────────────────

describe('NBDKIT_TRANSPORT_RE', () => {
  it('matches transport mode', () => {
    const m = 'transport mode: nbdssl'.match(NBDKIT_TRANSPORT_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('nbdssl');
  });

  it('matches file transport', () => {
    const m = 'transport mode: file'.match(NBDKIT_TRANSPORT_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('file');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// COW_FILE_SIZE_RE
// ────────────────────────────────────────────────────────────────────────────

describe('COW_FILE_SIZE_RE', () => {
  it('matches cow underlying file size', () => {
    const m =
      'nbdkit: vddk[1]: debug: cow: underlying file size: 10737418240'.match(
        COW_FILE_SIZE_RE,
      );
    expect(m).not.toBeNull();
    expect(m![1]).toBe('10737418240');
  });

  it('does not match line without cow size', () => {
    expect('nbdkit: debug: something else'.match(COW_FILE_SIZE_RE)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// finalizeNbdkit
// ────────────────────────────────────────────────────────────────────────────

describe('finalizeNbdkit', () => {
  it('adds nbdkit connection to map with socket path as id', () => {
    const map = new Map<string, NbdkitConnection>();
    const partial = {
      socketPath: '/tmp/nbd.sock',
      uri: 'nbd+unix:///?socket=/tmp/nbd.sock',
      plugin: 'vddk',
      startLine: 10,
      logLines: ['line1'],
    };
    finalizeNbdkit(partial, map, 50);
    expect(map.size).toBe(1);
    const conn = map.get('/tmp/nbd.sock')!;
    expect(conn.id).toBe('/tmp/nbd.sock');
    expect(conn.socketPath).toBe('/tmp/nbd.sock');
    expect(conn.uri).toBe('nbd+unix:///?socket=/tmp/nbd.sock');
    expect(conn.plugin).toBe('vddk');
    expect(conn.endLine).toBe(50);
    expect(conn.logLines).toEqual(['line1']);
  });

  it('uses nbdkit-N as id when socket path is empty', () => {
    const map = new Map<string, NbdkitConnection>();
    finalizeNbdkit({ startLine: 1 }, map, 20);
    expect(map.size).toBe(1);
    expect(map.has('nbdkit-0')).toBe(true);
    expect(map.get('nbdkit-0')!.id).toBe('nbdkit-0');
  });

  it('increments nbdkit-N id for multiple connections without socket', () => {
    const map = new Map<string, NbdkitConnection>();
    finalizeNbdkit({}, map, 10);
    finalizeNbdkit({}, map, 20);
    expect(map.has('nbdkit-0')).toBe(true);
    expect(map.has('nbdkit-1')).toBe(true);
  });

  it('does not overwrite existing entry with same id', () => {
    const map = new Map<string, NbdkitConnection>();
    map.set('/tmp/sock', {
      id: '/tmp/sock',
      socketPath: '/tmp/sock',
      uri: 'old',
      plugin: '',
      filters: [],
      diskFile: '',
      startLine: 1,
      endLine: 5,
      logLines: [],
    });
    finalizeNbdkit(
      { socketPath: '/tmp/sock', uri: 'new', startLine: 1 },
      map,
      10,
    );
    expect(map.size).toBe(1);
    expect(map.get('/tmp/sock')!.uri).toBe('old');
  });

  it('populates optional fields when provided', () => {
    const map = new Map<string, NbdkitConnection>();
    finalizeNbdkit(
      {
        socketPath: '/tmp/s',
        server: '10.0.0.1',
        vmMoref: 'vm-42',
        transportMode: 'nbdssl',
        backingSize: 12345,
        filters: ['cow'],
        diskFile: '/tmp/disk.vmdk',
      },
      map,
      100,
    );
    const conn = map.get('/tmp/s')!;
    expect(conn.server).toBe('10.0.0.1');
    expect(conn.vmMoref).toBe('vm-42');
    expect(conn.transportMode).toBe('nbdssl');
    expect(conn.backingSize).toBe(12345);
    expect(conn.filters).toEqual(['cow']);
    expect(conn.diskFile).toBe('/tmp/disk.vmdk');
  });
});
