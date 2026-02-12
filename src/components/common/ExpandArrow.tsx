/**
 * A consistent expand/collapse arrow that uses the same glyph (▶)
 * rotated 90° when expanded, avoiding size differences between
 * ▶ (U+25B6) and ▼ (U+25BC) in many fonts.
 */
export function ExpandArrow({ expanded, className = '' }: { expanded: boolean; className?: string }) {
  return (
    <span className={`inline-block transition-transform duration-150 ${expanded ? 'rotate-90' : ''} ${className}`}>
      ▶
    </span>
  );
}
