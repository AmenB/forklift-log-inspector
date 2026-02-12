/**
 * Hivex registry parsing for virt-v2v logs.
 * Handles hivex trace output decoding and session state management.
 */

import type { V2VRegistryHiveAccess } from '../../types/v2v';

/** Mutable state for tracking a hivex registry session within the parser. */
export interface HivexSessionState {
  hivePath: string;
  mode: 'read' | 'write';
  keySegments: string[];
  values: { name: string; value: string; lineNumber: number }[];
  pendingGetValueName: string | null;
  /** Child name from hivex_node_get_child call, awaiting the = result to confirm navigation */
  pendingChildName: string | null;
  /** Parent handle for the pending child (for root-detection) */
  pendingChildParent: string | null;
  lineNumber: number;
  rootHandle: string;
  hasWriteOp: boolean;
  firstWriteLine: number;
}

/**
 * Parse a single \xHH hex escape at position i in string s.
 * Returns the byte value and number of characters consumed, or null.
 */
export function parseHexEscapeAt(s: string, i: number): { byte: number; consumed: number } | null {
  if (s[i] === '\\' && i + 3 < s.length && s[i + 1] === 'x') {
    const hex = s.substring(i + 2, i + 4);
    const val = parseInt(hex, 16);
    if (!isNaN(val)) return { byte: val, consumed: 4 };
  }
  return null;
}

/** Flush a hivex session into the accesses array if it has data. */
export function flushHivexSession(
  session: HivexSessionState | null,
  accesses: V2VRegistryHiveAccess[],
): void {
  if (!session) return;
  const keyPath = session.keySegments.join('\\');

  // Skip empty sessions — no path and no values means nothing meaningful to record
  if (!keyPath && session.values.length === 0) return;

  // Determine actual mode: use hasWriteOp to distinguish read navigations
  // within a write-mode session from actual write operations
  const actualMode: 'read' | 'write' = session.hasWriteOp ? 'write' : 'read';

  // For writes, point to the first write operation; for reads, use navigation start
  const lineNumber = (actualMode === 'write' && session.firstWriteLine)
    ? session.firstWriteLine
    : session.lineNumber;

  // Avoid duplicate entries: if the last entry has the same hive, key path, mode, and
  // line number, merge values into it instead of creating a new entry
  const last = accesses.length > 0 ? accesses[accesses.length - 1] : null;
  if (
    last &&
    last.hivePath === session.hivePath &&
    last.keyPath === keyPath &&
    last.mode === actualMode &&
    last.lineNumber === lineNumber
  ) {
    // Merge values
    last.values.push(...session.values);
    return;
  }

  accesses.push({
    hivePath: session.hivePath,
    mode: actualMode,
    keyPath,
    values: session.values,
    lineNumber,
  });
}

/**
 * Decode the raw escaped byte data from hivex_node_set_value traces into
 * a human-readable string.
 *
 * Registry types:
 *   1 = REG_SZ (UTF-16LE string)
 *   2 = REG_EXPAND_SZ (UTF-16LE string with env-var refs)
 *   4 = REG_DWORD (32-bit LE integer)
 *   7 = REG_MULTI_SZ (series of null-terminated UTF-16LE strings)
 *   3 = REG_BINARY
 */
export function decodeHivexData(rawData: string, regType: number): string {
  const bytes = parseEscapedHivexBytes(rawData);

  if (regType === 4 && bytes.length >= 4) {
    // REG_DWORD – little-endian 32-bit unsigned
    const value = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | ((bytes[3] << 24) >>> 0)) >>> 0;
    return String(value);
  }

  if (regType === 1 || regType === 2 || regType === 7) {
    // REG_SZ / REG_EXPAND_SZ / REG_MULTI_SZ – UTF-16LE
    return decodeUtf16LE(bytes);
  }

  // REG_BINARY or other – show hex summary
  if (bytes.length <= 16) {
    return bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
  }
  return `(${bytes.length} bytes)`;
}

/** Decode UTF-16LE bytes to a JS string, stopping at null terminator. */
export function decodeUtf16LE(bytes: number[]): string {
  let result = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (code === 0) break; // null terminator
    result += String.fromCharCode(code);
  }
  return result;
}

/**
 * Parse the escaped byte string from libguestfs hivex trace output.
 *
 * libguestfs trace format:
 *   `\xHH` → byte value HH (hex) — used for non-printable bytes
 *   `\`    → literal backslash (byte 0x5C) when NOT followed by `xHH`
 *   any other char → its ASCII byte value
 *
 * IMPORTANT: libguestfs does NOT double-escape backslashes. A `\` in the
 * output is just byte 0x5C. So `\\x00` in the trace means byte 0x5C
 * followed by `\x00` (byte 0x00) — i.e. a UTF-16LE backslash character.
 */
export function parseEscapedHivexBytes(s: string): number[] {
  const bytes: number[] = [];
  let i = 0;
  while (i < s.length) {
    const esc = parseHexEscapeAt(s, i);
    if (esc) {
      bytes.push(esc.byte);
      i += esc.consumed;
    } else {
      bytes.push(s.charCodeAt(i));
      i++;
    }
  }
  return bytes;
}
