/**
 * Unified date/time formatting utilities
 */

/**
 * Check if a date is a valid, meaningful date (not epoch 1970, not invalid)
 */
export function isValidDate(date: Date | string | undefined | null): boolean {
  if (!date) return false;
  try {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return false;
    // Treat epoch (1970-01-01) as invalid/unknown
    if (d.getFullYear() <= 1970) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Format a date string to a human-readable datetime format
 * Output: "YYYY-MM-DD HH:mm:ss.mmm" or empty string for unknown dates
 */
export function formatDateTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    if (date.getFullYear() <= 1970) return '';
    
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
  } catch {
    return dateStr;
  }
}

/**
 * Format a timestamp (Date or string) to ISO-like format without timezone
 * Output: "YYYY-MM-DD HH:mm:ss.mmm" or 'Unknown' for invalid/epoch dates
 */
export function formatTimestamp(date: Date | string | undefined): string {
  if (!date) return 'Unknown';
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return typeof date === 'string' ? date : 'Unknown';
    if (d.getFullYear() <= 1970) return 'Unknown';
    return d.toISOString().replace('T', ' ').replace('Z', '');
  } catch {
    return typeof date === 'string' ? date : 'Unknown';
  }
}

/**
 * Format a Date for display, returning empty string for unknown/epoch dates
 */
export function formatDateLocale(date: Date | undefined | null): string {
  if (!date) return '';
  if (!isValidDate(date)) return '';
  return date.toLocaleString();
}

/**
 * Get relative time string (e.g., "2 hours ago", "5 minutes ago")
 */
export function getRelativeTime(date: Date | string): string {
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffDays > 0) {
      return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
    }
    if (diffHours > 0) {
      return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    }
    if (diffMinutes > 0) {
      return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''} ago`;
    }
    if (diffSeconds > 0) {
      return `${diffSeconds} second${diffSeconds !== 1 ? 's' : ''} ago`;
    }
    return 'just now';
  } catch {
    return '';
  }
}
