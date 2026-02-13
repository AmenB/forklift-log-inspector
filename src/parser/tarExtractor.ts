/**
 * Browser-based tar/gzip/zip extraction with recursive nested archive support.
 *
 * Uses the native DecompressionStream API for gzip and manually parses
 * the tar format (512-byte headers).  Gzipped archives are parsed in a
 * **streaming** fashion so the entire decompressed content is never held
 * in memory at once.  ZIP files are extracted via the `fflate` library.
 * Nested .tar / .tar.gz / .tgz / .zip entries are recursively extracted
 * and flattened into a single list.
 */

import { unzip as fflateUnzip } from 'fflate';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TarEntry {
  /** Full path inside the archive (nested paths are joined with '/') */
  path: string;
  /** Text content decoded via UTF-8 */
  content: string;
  /** Raw bytes – kept so nested tars can be re-parsed */
  rawBytes: Uint8Array;
}

// ── Constants ──────────────────────────────────────────────────────────────

const TAR_BLOCK = 512;
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** Skip individual files larger than this (50 MB) to avoid memory pressure */
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

/**
 * File extensions that are definitely not text/log/yaml content.
 * Skipping these avoids the cost of UTF-8 decoding + string allocation
 * for files that will never match any classifier.
 */
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.bmp',
  '.mp4', '.webm', '.avi', '.mov', '.mp3', '.wav', '.ogg',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.class', '.pyc', '.pyo', '.wasm',
  '.db', '.sqlite', '.sqlite3',
  '.rpm', '.deb', '.dmg', '.iso',
]);

/** Check if a file path ends with a known non-text extension */
function shouldSkipByExtension(path: string): boolean {
  const lower = path.toLowerCase();
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx === -1) return false;
  return SKIP_EXTENSIONS.has(lower.slice(dotIdx));
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Extract all files from a tar or tar.gz archive supplied as a File or
 * Uint8Array.  Nested archives (.tar, .tar.gz, .tgz) are recursively
 * extracted and the results flattened.
 */
export async function extractArchive(
  input: File | Uint8Array,
  pathPrefix = '',
): Promise<TarEntry[]> {
  const bytes = input instanceof File
    ? new Uint8Array(await input.arrayBuffer())
    : input;

  // Route to ZIP extractor if the content is a ZIP file
  if (isZip(bytes)) {
    return extractZip(bytes, pathPrefix);
  }

  // Otherwise handle as tar (gzipped or plain)
  const rawEntries = isGzip(bytes)
    ? await streamParseGzippedTar(bytes, pathPrefix)
    : parseTarBytes(bytes, pathPrefix);

  // Recursively extract nested archives
  return flattenNestedArchives(rawEntries);
}

// ── Recursive flattening ───────────────────────────────────────────────────

async function flattenNestedArchives(entries: TarEntry[]): Promise<TarEntry[]> {
  const result: TarEntry[] = [];

  for (const entry of entries) {
    if (isArchiveEntry(entry.path)) {
      try {
        const prefix = stripArchiveExt(entry.path);
        // Route to the right extractor based on content magic bytes
        const nested = isZip(entry.rawBytes)
          ? await extractZip(entry.rawBytes, prefix)
          : await extractArchive(entry.rawBytes, prefix);
        result.push(...nested);
      } catch {
        // If nested extraction fails, keep the entry as-is
        result.push(entry);
      }
    } else {
      result.push(entry);
    }
  }

  return result;
}

// ── Streaming gzip+tar parser ──────────────────────────────────────────────

/**
 * Decompress a gzipped tar and parse entries in one streaming pass.
 * The full decompressed content is **never** materialised in memory.
 */
async function streamParseGzippedTar(
  compressed: Uint8Array,
  pathPrefix: string,
): Promise<TarEntry[]> {
  // Pipe compressed bytes through DecompressionStream
  const inputStream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Enqueue the compressed buffer and close
      controller.enqueue(compressed);
      controller.close();
    },
  });

  const decompressed = inputStream.pipeThrough(
    new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  const reader = decompressed.getReader();
  const buf = new StreamingBuffer(reader);

  return parseTarFromStream(buf, pathPrefix);
}

// ── StreamingBuffer ────────────────────────────────────────────────────────

/**
 * Wraps a ReadableStreamDefaultReader and provides exact-byte-count read
 * and efficient skip operations.  Only the data currently being processed
 * is kept in memory.
 */
class StreamingBuffer {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer: Uint8Array = new Uint8Array(0);
  private eof = false;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  /** Read exactly `n` bytes.  Returns null if the stream ends first. */
  async readExact(n: number): Promise<Uint8Array | null> {
    // Fast path: already have enough buffered
    if (this.buffer.byteLength >= n) {
      const result = this.buffer.slice(0, n);
      this.buffer = this.buffer.subarray(n);
      return result;
    }

    // Collect chunks until we have enough
    const chunks: Uint8Array[] = [this.buffer];
    let collected = this.buffer.byteLength;
    this.buffer = new Uint8Array(0);

    while (collected < n && !this.eof) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.eof = true;
        break;
      }
      chunks.push(value);
      collected += value.byteLength;
    }

    if (collected < n) return null;

    // Concatenate once
    const combined = new Uint8Array(collected);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const result = combined.slice(0, n);
    if (collected > n) {
      this.buffer = combined.subarray(n);
    }
    return result;
  }

  /**
   * Skip `n` bytes efficiently without accumulating them.
   * Chunks are consumed and discarded as they arrive.
   */
  async skip(n: number): Promise<void> {
    let remaining = n;

    // First consume from the existing buffer
    if (this.buffer.byteLength > 0) {
      if (this.buffer.byteLength >= remaining) {
        this.buffer = this.buffer.subarray(remaining);
        return;
      }
      remaining -= this.buffer.byteLength;
      this.buffer = new Uint8Array(0);
    }

    // Consume and discard chunks from the stream
    while (remaining > 0 && !this.eof) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.eof = true;
        break;
      }
      if (value.byteLength > remaining) {
        // Keep the leftover
        this.buffer = value.subarray(remaining);
        remaining = 0;
      } else {
        remaining -= value.byteLength;
      }
    }
  }
}

// ── Streaming tar parser ───────────────────────────────────────────────────

async function parseTarFromStream(
  buf: StreamingBuffer,
  pathPrefix: string,
): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let longName = '';

  for (;;) {
    // Read 512-byte header
    const header = await buf.readExact(TAR_BLOCK);
    if (!header) break; // stream ended

    // Two consecutive zero blocks → end-of-archive
    if (isZeroBlock(header)) {
      // Try to read the next block to check for second zero block
      const next = await buf.readExact(TAR_BLOCK);
      if (!next || isZeroBlock(next)) break;
      // Not a second zero block — treat `next` as the next header
      // (push it back by re-processing below; but our buffer API doesn't
      //  support unread, so we process it inline)
      const entry = await processHeader(next, buf, decoder, pathPrefix, longName);
      if (entry === 'longname') {
        longName = await readLongName(buf, next, decoder);
      } else {
        if (entry) entries.push(entry);
        longName = '';
      }
      continue;
    }

    const headerResult = await processHeader(header, buf, decoder, pathPrefix, longName);
    if (headerResult === 'longname') {
      longName = await readLongName(buf, header, decoder);
    } else {
      if (headerResult) entries.push(headerResult);
      longName = '';
    }
  }

  return entries;
}

/**
 * Process a single tar header and its associated data.
 * Returns a TarEntry, the string 'longname' if this was a GNU LongName
 * header (caller should read the long name), or null to skip.
 */
async function processHeader(
  header: Uint8Array,
  buf: StreamingBuffer,
  decoder: TextDecoder,
  pathPrefix: string,
  longName: string,
): Promise<TarEntry | 'longname' | null> {
  const rawName = readString(header, 0, 100);
  const sizeOctal = readString(header, 124, 12);
  const typeFlag = readString(header, 156, 1);
  const prefix = readString(header, 345, 155);

  const size = parseOctal(sizeOctal);
  const aligned = alignToBlock(size);

  // GNU LongName (type 'L') — caller will read the content
  if (typeFlag === 'L') {
    return 'longname';
  }

  // Build file name
  let name = longName || (prefix ? `${prefix}/${rawName}` : rawName);
  name = name.replace(/\0+$/, '');
  const fullPath = pathPrefix ? `${pathPrefix}/${name}` : name;

  // Skip directories, empty files, and non-regular files
  if (
    typeFlag === '5' ||
    name.endsWith('/') ||
    size === 0 ||
    (typeFlag !== '0' && typeFlag !== '' && typeFlag !== '\0')
  ) {
    await buf.skip(aligned);
    return null;
  }

  // Skip oversized entries to avoid memory pressure
  if (size > MAX_ENTRY_BYTES) {
    await buf.skip(aligned);
    return null;
  }

  // Skip known binary/media files (avoids costly UTF-8 decode + string alloc)
  if (!isArchiveEntry(fullPath) && shouldSkipByExtension(fullPath)) {
    await buf.skip(aligned);
    return null;
  }

  // Read file content
  const rawBytes = await buf.readExact(aligned);
  if (!rawBytes) return null;

  const fileBytes = rawBytes.slice(0, size);
  const content = decoder.decode(fileBytes);

  return { path: fullPath, content, rawBytes: fileBytes };
}

/** Read the content of a GNU LongName header entry */
async function readLongName(
  buf: StreamingBuffer,
  header: Uint8Array,
  decoder: TextDecoder,
): Promise<string> {
  const sizeOctal = readString(header, 124, 12);
  const size = parseOctal(sizeOctal);
  const aligned = alignToBlock(size);

  const nameBytes = await buf.readExact(aligned);
  if (!nameBytes) return '';
  return decoder.decode(nameBytes.subarray(0, size)).replace(/\0+$/, '');
}

// ── Synchronous parser for in-memory (non-gzipped) tars ────────────────────

function parseTarBytes(bytes: Uint8Array, pathPrefix: string): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let longName = '';

  while (offset + TAR_BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK);

    if (isZeroBlock(header)) {
      if (
        offset + 2 * TAR_BLOCK <= bytes.length &&
        isZeroBlock(bytes.subarray(offset + TAR_BLOCK, offset + 2 * TAR_BLOCK))
      ) {
        break;
      }
      offset += TAR_BLOCK;
      continue;
    }

    const rawName = readString(header, 0, 100);
    const sizeOctal = readString(header, 124, 12);
    const typeFlag = readString(header, 156, 1);
    const prefix = readString(header, 345, 155);

    const size = parseOctal(sizeOctal);
    offset += TAR_BLOCK; // move past header

    // GNU LongName
    if (typeFlag === 'L') {
      const nameBytes = bytes.subarray(offset, offset + size);
      longName = decoder.decode(nameBytes).replace(/\0+$/, '');
      offset += alignToBlock(size);
      continue;
    }

    let name = longName || (prefix ? `${prefix}/${rawName}` : rawName);
    longName = '';
    name = name.replace(/\0+$/, '');
    const fullPath = pathPrefix ? `${pathPrefix}/${name}` : name;

    // Skip directories, empty, non-regular, oversized, known-binary
    if (
      typeFlag === '5' ||
      name.endsWith('/') ||
      size === 0 ||
      (typeFlag !== '0' && typeFlag !== '' && typeFlag !== '\0') ||
      size > MAX_ENTRY_BYTES ||
      (!isArchiveEntry(fullPath) && shouldSkipByExtension(fullPath))
    ) {
      offset += alignToBlock(size);
      continue;
    }

    const rawBytes = bytes.slice(offset, offset + size);
    const content = decoder.decode(rawBytes);
    entries.push({ path: fullPath, content, rawBytes });

    offset += alignToBlock(size);
  }

  return entries;
}

// ── ZIP extraction ────────────────────────────────────────────────────────

const ZIP_MAGIC_0 = 0x50; // 'P'
const ZIP_MAGIC_1 = 0x4b; // 'K'

function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === ZIP_MAGIC_0 &&
    bytes[1] === ZIP_MAGIC_1 &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  );
}

/**
 * Wrap fflate's callback-based unzip in a Promise.
 */
function unzipAsync(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    fflateUnzip(data, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

/**
 * Extract all files from a ZIP archive.
 * Returns TarEntry[] for compatibility with the rest of the pipeline.
 */
export async function extractZip(
  input: File | Uint8Array,
  pathPrefix = '',
): Promise<TarEntry[]> {
  const bytes = input instanceof File
    ? new Uint8Array(await input.arrayBuffer())
    : input;

  const files = await unzipAsync(bytes);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const entries: TarEntry[] = [];

  for (const [name, data] of Object.entries(files)) {
    // Skip directories (fflate includes them as empty entries)
    if (name.endsWith('/') || data.length === 0) continue;
    // Skip oversized entries
    if (data.length > MAX_ENTRY_BYTES) continue;
    const fullPath = pathPrefix ? `${pathPrefix}/${name}` : name;
    // Skip known binary/media files
    if (!isArchiveEntry(fullPath) && shouldSkipByExtension(name)) continue;
    const content = decoder.decode(data);
    entries.push({ path: fullPath, content, rawBytes: data });
  }

  // Recursively extract nested archives
  return flattenNestedArchives(entries);
}

// ── Public Helpers ─────────────────────────────────────────────────────────

/**
 * Check whether raw bytes represent a ZIP archive.
 */
export { isZip };

/**
 * Decompress a gzipped file (non-tar) and return the text content.
 * Uses the native DecompressionStream API.
 */
export async function decompressGzipToText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);

  if (!isGzip(bytes)) {
    // Not actually gzipped — decode as plain text
    return new TextDecoder('utf-8').decode(bytes);
  }

  const inputStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  const decompressed = inputStream.pipeThrough(
    new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
  );

  const reader = decompressed.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder('utf-8').decode(result);
}

// ── Internal Helpers ──────────────────────────────────────────────────────

function isGzip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 2 &&
    bytes[0] === GZIP_MAGIC_0 &&
    bytes[1] === GZIP_MAGIC_1
  );
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function readString(buf: Uint8Array, offset: number, length: number): string {
  let end = offset + length;
  while (end > offset && buf[end - 1] === 0) end--;
  const slice = buf.subarray(offset, end);
  return new TextDecoder('ascii').decode(slice);
}

function parseOctal(str: string): number {
  const trimmed = str.trim();
  if (!trimmed) return 0;
  return parseInt(trimmed, 8) || 0;
}

/** Round up to the next 512-byte boundary */
function alignToBlock(size: number): number {
  return Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
}

/** Check if a path looks like an archive entry (tar or zip) */
function isArchiveEntry(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith('.tar') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz') ||
    lower.endsWith('.zip')
  );
}

/** Strip the archive extension to use as a path prefix for nested contents */
function stripArchiveExt(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tar.gz')) return path.slice(0, -7);
  if (lower.endsWith('.tgz')) return path.slice(0, -4);
  if (lower.endsWith('.tar')) return path.slice(0, -4);
  if (lower.endsWith('.zip')) return path.slice(0, -4);
  return path;
}
