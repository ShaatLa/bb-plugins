import type { PluginSidebarThread } from '@get-bb/plugin-sdk/app';
export const threadTarget = (thread: PluginSidebarThread) => ({ ...thread, environment: thread.environment?.id ? { id: thread.environment.id, path: thread.environment.path } : null });
