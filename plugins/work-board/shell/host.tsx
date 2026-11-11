import { createContext, useContext, useMemo } from "react";
import { useRealtime, useRpc, type PluginRpcClient, type PluginRpcContract } from "@get-bb/plugin-sdk/app";

/**
 * Lets another plugin render Work Board views against Work Board's own backend.
 * Without a provider every hook below falls back to the calling plugin's SDK hooks,
 * which inside Work Board are Work Board's own RPC and realtime.
 * Keep the object stable (memoize it) and present for the whole mounted tree.
 */
export interface WorkBoardHost {
  /** Calls a Work Board RPC method (POST /api/v1/plugins/work-board/rpc/<method>) and resolves with its `result`. */
  call(method: string, input?: unknown): Promise<unknown>;
  /** React hook: subscribe `handler` to a Work Board realtime channel such as `tasks:changed`. */
  useRealtime(channel: string, handler: (payload: unknown) => void): void;
  /** Opens a Work Board panel location (the work-board nav panel's subPath, e.g. `task/TSK-4`). */
  openInWorkBoard?(subPath: string): void;
}

const WorkBoardHostContext = createContext<WorkBoardHost | null>(null);
export const WorkBoardHostProvider = WorkBoardHostContext.Provider;

export function useWorkBoardHost(): WorkBoardHost | null {
  return useContext(WorkBoardHostContext);
}

export function useWorkBoardRpc<Contract extends PluginRpcContract>(): PluginRpcClient<Contract> {
  const host = useWorkBoardHost();
  const sdkRpc = useRpc<Contract>();
  return useMemo(
    () => (host ? ({ call: (method: string, ...args: unknown[]) => host.call(method, args[0]) } as PluginRpcClient<Contract>) : sdkRpc),
    [host, sdkRpc],
  );
}

const ignore = () => {};
const noHostRealtime: WorkBoardHost["useRealtime"] = () => {};

export function useWorkBoardRealtime(channel: string, handler: (payload: unknown) => void): void {
  const host = useWorkBoardHost();
  // Inside another plugin the SDK channel is that plugin's own, so it must not drive Work Board views.
  useRealtime(channel, host ? ignore : handler);
  (host?.useRealtime ?? noHostRealtime)(channel, handler);
}
