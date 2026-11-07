import { useEffect, useState } from "react";
import { experimental_copyToClipboard, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";

export function ShareTaskButton({ taskKey }: { taskKey: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { setCopied(false); setError(false); }, [taskKey]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return <span className="inline-flex items-center gap-1" title="Copy task link to paste into an agent chat">
    <Button type="button" size="sm" variant="ghost" className="h-7" aria-label={`Share ${taskKey} with agent`} onClick={async () => {
      setError(false);
      try {
        const ok = await experimental_copyToClipboard({ text: `[${taskKey}](/plugins/work-board/work-board/task/${encodeURIComponent(taskKey)})` });
        if (!ok) throw new Error("Clipboard write failed");
        setCopied(true);
      } catch { setCopied(false); setError(true); }
    }}><Icon name={copied ? "Check" : "Copy"} className="size-3.5" />{copied ? "Copied" : "Share"}</Button>
    {error ? <span role="alert" className="text-xs text-destructive">Could not copy task link.</span> : null}
    <span role="status" className="sr-only">{copied ? "Task link copied. Paste it into the agent chat." : ""}</span>
  </span>;
}
