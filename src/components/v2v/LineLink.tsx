import { createContext, useContext } from 'react';
import { useV2VStore } from '../../store/useV2VStore';

interface LineLinkProps {
  /** Global line number (0-based, as stored in parsed data) */
  line: number;
  /** Optional label override; defaults to "L{line+1}" */
  label?: string;
}

/**
 * Context that, when provided, is called after a LineLink navigates.
 * Used by the stage modal to auto-close when a line link is clicked.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const LineLinkNavigateContext = createContext<(() => void) | null>(null);

/**
 * A clickable line-number badge that highlights the referenced line
 * in the Raw Log viewer (auto-expanding it if collapsed).
 */
export function LineLink({ line, label }: LineLinkProps) {
  const setHighlightedLine = useV2VStore((s) => s.setHighlightedLine);
  const onNavigate = useContext(LineLinkNavigateContext);

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        setHighlightedLine(line);
        onNavigate?.();
      }}
      title={`Go to line ${line + 1} in raw log`}
      className="font-mono text-[10px] text-slate-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 hover:underline cursor-pointer transition-colors"
    >
      {label ?? `L${line + 1}`}
    </button>
  );
}
