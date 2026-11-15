import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

// Subsets of bb--git's public RPC contract; additional host fields are ignored.
const failure = z.union([
  z.object({ outcome: z.literal('not_applicable'), message: z.string() }),
  z.object({ outcome: z.literal('unavailable'), failure: z.object({ message: z.string() }) }),
  z.object({ outcome: z.literal('failed'), message: z.string() }),
]);
const fileStatus = z.object({ path: z.string(), status: z.string(), insertions: z.number().nullable(), deletions: z.number().nullable() });
const summary = z.object({ fileCount: z.number(), files: z.array(fileStatus) });
const workspace = z.object({
  branch: z.object({ currentBranch: z.string().nullable(), defaultBranch: z.string() }),
  workingTree: summary.extend({ hasUncommittedChanges: z.boolean() }),
  mergeBase: summary.extend({ mergeBaseBranch: z.string(), aheadCount: z.number(), behindCount: z.number(), commits: z.array(z.object({ sha: z.string(), shortSha: z.string(), subject: z.string() })) }).nullable(),
});
const target = z.union([z.object({ type: z.literal('uncommitted') }), z.object({ type: z.literal('branch_committed'), mergeBaseBranch: z.string() })]);
const scope = z.object({ environmentId: z.string(), target });
const patch = z.object({ path: z.string(), patch: z.string(), truncated: z.boolean() });
const file = z.object({ path: z.string(), revision: z.string(), changeKind: z.string(), additions: z.number(), deletions: z.number(), binary: z.boolean(), loadMode: z.enum(['auto', 'on_demand', 'too_large']) });
export const gitContract = defineRpcContract({
  status: { input: z.object({ keys: z.array(z.string()) }), output: z.record(z.string(), z.union([z.object({ outcome: z.literal('available'), workspace }), failure])) },
  files: { input: scope.extend({ ignoreWhitespace: z.boolean() }), output: z.union([z.object({ outcome: z.literal('available'), files: z.array(file), initialPatches: z.array(patch), truncated: z.boolean() }), failure]) },
  patches: { input: z.object({ keys: z.array(z.string()) }), output: z.record(z.string(), z.union([z.object({ outcome: z.literal('available'), patch }), failure])) },
  viewed: { input: scope, output: z.object({ files: z.array(z.object({ path: z.string(), revision: z.string() })) }) },
  markViewed: { input: scope.extend({ path: z.string(), revision: z.string() }), output: z.object({ ok: z.literal(true) }) },
  clearViewed: { input: scope.extend({ path: z.string() }), output: z.object({ ok: z.literal(true) }) },
});
export const boardContract = defineRpcContract({ threadTasks: {
  input: z.object({ threadId: z.string() }),
  output: z.object({ tasks: z.array(z.object({ key: z.string(), title: z.string(), status: z.object({ id: z.string(), name: z.string(), icon: z.string().optional(), color: z.string().optional() }), projectName: z.string(), archived: z.boolean(), url: z.string() })) }),
} });
export type GitFile = z.infer<typeof file>;
export type GitTarget = z.infer<typeof target>;
export function unavailable(result: z.infer<typeof failure> | undefined) {
  return result?.outcome === 'unavailable' ? result.failure.message : result?.message;
}
