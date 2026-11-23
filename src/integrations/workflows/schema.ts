/**
 * The shapes of a Workflows run as the bundled Workflows plugin answers them.
 * Read with defaults and loose objects, since that plugin can change.
 */
import { z } from "zod";

const optionalText = z.string().nullish();
const optionalTime = z.number().nullish();

const callSchema = z
  .object({
    id: z.string(),
    index: z.number(),
    label: optionalText,
    phase: optionalText,
    status: z.string(),
    provider: optionalText,
    model: optionalText,
    reasoningLevel: optionalText,
    cached: z.boolean().nullish(),
    childThreadId: optionalText,
    providerRetryAttempts: z.number().nullish(),
    repairAttempts: z.number().nullish(),
    error: optionalText,
    createdAt: z.number(),
    startedAt: optionalTime,
    finishedAt: optionalTime,
  })
  .loose();

const runViewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    phases: z
      .array(z.object({ title: optionalText, calls: z.array(callSchema).default([]) }).loose())
      .default([]),
    unphasedCalls: z.array(callSchema).default([]),
    error: optionalText,
    createdAt: z.number(),
    startedAt: optionalTime,
    finishedAt: optionalTime,
  })
  .loose();

export const runViewResultSchema = z.object({ run: runViewSchema.nullable() }).loose();

export type WorkflowRunView = z.infer<typeof runViewSchema>;
export type WorkflowCall = z.infer<typeof callSchema>;

/** Run states after which Workflows does no more work on a run. */
const ENDED_STATES = new Set(["succeeded", "failed", "cancelled"]);

export function workflowEnded(run: Pick<WorkflowRunView, "status">): boolean {
  return ENDED_STATES.has(run.status);
}

export function allCalls(run: WorkflowRunView): WorkflowCall[] {
  return [...run.phases.flatMap((phase) => phase.calls), ...run.unphasedCalls];
}
