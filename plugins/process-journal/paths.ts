export const journalPath = (project?: string) =>
  "/plugins/process-journal/process-journal" + (project ? `/${encodeURIComponent(project)}` : "");
export const proposalPath = (project: string, id: string) =>
  `${journalPath(project)}/${encodeURIComponent(id)}`;
export const cardPath = (key: string) => `/plugins/work-board/work-board/task/${encodeURIComponent(key)}`;
export const hiddenColumnsPath = (project: string, proposal?: string) =>
  `${journalPath(project)}/board/hidden${proposal ? `/${encodeURIComponent(proposal)}` : ""}`;
export const reviewRunsPath = (project: string) => `${journalPath(project)}/review/runs`;
export const settingsPath = "/settings/plugins/process-journal";
