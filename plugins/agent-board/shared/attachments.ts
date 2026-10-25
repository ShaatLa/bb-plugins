export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

export function attachmentDownloadUrl(attachmentId: string): string {
  return `/api/v1/plugins/agent-board/http/attachments/download?attachmentId=${encodeURIComponent(attachmentId)}`;
}

export function rewriteLegacyAttachmentLinks(text: string): string {
  return text.replace(
    /\/api\/v1\/plugins\/(?:tasks-plus|tasks)\//g,
    "/api/v1/plugins/agent-board/",
  );
}
