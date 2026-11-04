import type { PrLinkState } from "../shared/git-sync";

/** True when a linked PR was closed without merging, using the last known snapshot. */
export function hasClosedUnmergedPr(links: readonly PrLinkState[]): boolean {
  return links.some(({ link, snapshot }) => !link.excluded && snapshot?.state === "closed");
}
