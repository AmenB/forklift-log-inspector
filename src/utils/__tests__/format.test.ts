import { describe, it, expect } from 'vitest';
import { formatBytes, formatDuration, formatMemory } from '../format';

describe('formatBytes', () => {
  it('returns bytes for values under 1 KB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('returns KB for values under 1 MB', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1023)).toBe('1023.0 KB');
  });

  it('returns MB for values under 1 GB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 500)).toBe('500.0 MB');
  });

  it('returns GB for values 1 GB and above', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe('2.5 GB');
  });
});

describe('formatDuration', () => {
  it('returns seconds for values under 60', () => {
    expect(formatDuration(0)).toBe('0.0s');
    expect(formatDuration(1.23)).toBe('1.2s');
    expect(formatDuration(59.9)).toBe('59.9s');
  });

  it('returns minutes and seconds for values under 1 hour', () => {
    expect(formatDuration(60)).toBe('1m 0s');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(3599)).toBe('59m 59s');
  });

  it('returns hours and minutes for values 1 hour and above', () => {
    expect(formatDuration(3600)).toBe('1h 0m');
    expect(formatDuration(7500)).toBe('2h 5m');
  });
});

describe('formatMemory', () => {
  it('returns MB for values under 1 GB', () => {
    expect(formatMemory(1024)).toBe('1 MB');
    expect(formatMemory(512)).toBe('1 MB'); // rounds up from 0.5
    expect(formatMemory(1024 * 512)).toBe('512 MB');
  });

  it('returns GB for values 1 GB (1048576 KB) and above', () => {
    expect(formatMemory(1024 * 1024)).toBe('1.0 GB');
    expect(formatMemory(1024 * 1024 * 4)).toBe('4.0 GB');
    expect(formatMemory(1024 * 1024 * 16)).toBe('16.0 GB');
  });
});
