export const proposalPath = (project: string, id: string) =>
  `/plugins/process-journal/process-journal/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
export const cardPath = (key: string) => `/plugins/work-board/work-board/task/${encodeURIComponent(key)}`;
