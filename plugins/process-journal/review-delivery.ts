import { proposalPath } from "./paths";
import { stableId, type Store } from "./store";
import type { Transport } from "./sweep";
import { minute } from "./time";

export async function deliverReviews(
  store: Store, transport: Transport, reachable: (projectId: string, threadId: string) => Promise<boolean>,
) {
  const { reviews } = store;
  for (const item of reviews.pending()) {
    let { round } = item;
    const { projectId, proposalId, version, generation, reviewerId } = round;
    const stage = round.snapshot.stage;
    const p = store.proposal(projectId, proposalId);
    const wanted = () => store.config(projectId).enabled && reviews.wanted(round);
    if (!wanted()) continue;
    const link = `[Open proposal](${proposalPath(projectId, proposalId)})`;
    const reference = `Review ${stage} v${version} · ${proposalId}`;
    const notify = async (flag: number, title: string, text: string) => {
      const tickId = stableId(projectId, proposalId, "proposal-review", stage, version, flag);
      try {
        await transport.notice({ projectId, threadId: store.proposal(projectId, proposalId).managerId, tickId,
          source: "process-journal", title, markdown: `${reference}. ${text} ${link}` });
        reviews.notified(round, flag);
      } catch {
        // The notice uses a stable delivery key and can be retried on the next sweep.
      }
    };

    if (round.delivery === "queued" && item.next <= store.now()) {
      round = reviews.save({ ...round, delivery: "sending" });
      const details = JSON.stringify({ proposalId, stage, version, generation, verdict: "YOUR_VERDICT", feedback: "Your review rationale" });
      const status = await transport.send(projectId, reviewerId, `${reference}. ${link}\n\n`
        + `Read the submitted snapshot with proposal-detail and record your independent decision with `
        + `bb process-journal review-decide --project ${projectId} --input '${details}'. `
        + "Choose approved or changes_requested and include your reasoning.", wanted);
      if (!wanted()) continue;
      if (status === "retry") round = reviews.save({ ...round, delivery: "queued" }, store.now() + minute);
      else if (status !== "obsolete") round = reviews.save({ ...round, delivery: status });
    }
    if (!(item.notice & 2) && (["unreachable", "uncertain"].includes(round.delivery)
      || round.delivery === "sent" && !await reachable(projectId, reviewerId)) && wanted()) {
      await notify(2, "Proposal reviewer needs attention", "Delivery could not be confirmed. The manager can check the reviewer or assign a replacement.");
    }
    if (!(item.notice & 1) && store.now() >= Math.min(p.deadlineAt, round.submittedAt + 24 * 60 * minute) && wanted()) {
      await notify(1, "Proposal review is overdue", "The proposal is waiting for an independent verdict.");
    }
  }
}
