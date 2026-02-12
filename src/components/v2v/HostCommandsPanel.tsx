import { useMemo, useState } from 'react';
import type { V2VHostCommand } from '../../types/v2v';
import { LineLink } from './LineLink';
import { ExpandArrow } from '../common';

interface HostCommandsPanelProps {
  commands: V2VHostCommand[];
}

interface CommandGroup {
  executable: string;
  commands: V2VHostCommand[];
}

export function HostCommandsPanel({ commands }: HostCommandsPanelProps) {
  const groups = useMemo<CommandGroup[]>(() => {
    const map = new Map<string, V2VHostCommand[]>();
    for (const cmd of commands) {
      // Normalize executable (strip path)
      const exe = cmd.command.split('/').pop() || cmd.command;
      const arr = map.get(exe) || [];
      arr.push(cmd);
      map.set(exe, arr);
    }
    return [...map.entries()]
      .map(([executable, cmds]) => ({ executable, commands: cmds }))
      .sort((a, b) => b.commands.length - a.commands.length);
  }, [commands]);

  if (groups.length === 0) {
    return <div className="text-sm text-slate-500 dark:text-gray-400 italic">No host commands detected.</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-[11px]">
        {groups.map((g) => (
          <span
            key={g.executable}
            className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-gray-300 font-mono"
          >
            {g.executable} <span className="text-slate-400 dark:text-gray-500">({g.commands.length})</span>
          </span>
        ))}
      </div>
      {groups.map((group) => (
        <CommandGroupCard key={group.executable} group={group} />
      ))}
    </div>
  );
}

function CommandGroupCard({ group }: { group: CommandGroup }) {
  const [expanded, setExpanded] = useState(false);
  const previewCount = 3;
  const shown = expanded ? group.commands : group.commands.slice(0, previewCount);

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-2 bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-left"
      >
        <ExpandArrow expanded={expanded} className="text-[10px] text-indigo-500 dark:text-indigo-400 flex-shrink-0" />
        <span className="text-xs font-semibold font-mono text-slate-800 dark:text-gray-200">
          {group.executable}
        </span>
        <span className="text-[10px] text-slate-400 dark:text-gray-500 ml-auto">
          {group.commands.length} invocation{group.commands.length !== 1 ? 's' : ''}
        </span>
      </button>
      {expanded && (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {shown.map((cmd, idx) => (
            <div key={idx} className="px-4 py-2 flex items-start gap-2 text-[11px]">
              <span className="text-slate-400 dark:text-gray-500 flex-shrink-0 w-5 text-right">{idx + 1}</span>
              <code className="flex-1 font-mono text-slate-700 dark:text-gray-300 break-all">
                {cmd.command} {cmd.args.join(' ')}
              </code>
              <LineLink line={cmd.lineNumber} />
            </div>
          ))}
          {!expanded && group.commands.length > previewCount && (
            <div className="px-4 py-2 text-[11px] text-slate-400 dark:text-gray-500 italic">
              +{group.commands.length - previewCount} more...
            </div>
          )}
        </div>
      )}
    </div>
  );
}
