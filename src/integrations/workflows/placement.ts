/** Where a workflow run's spans are placed. */
import type { AttributeValue } from "../../core/otlp.js";

/** Where a workflow run's spans go: its own trace, or under a span of a provider's trace. */
export interface WorkflowPlacement {
  traceId: string;
  parentSpanId: string | null;
  /** Attributes of the enclosing provider trace, when there is one. */
  attributes: Record<string, AttributeValue>;
  /** Whether the workflow's name is the pipeline: not when the enclosing trace names one. */
  pipeline: boolean;
  /** The agent each worker thread runs as, by thread id, when a provider named it. */
  agents?: ReadonlyMap<string, { agentId: string | null; agentName: string | null }> | null;
}
