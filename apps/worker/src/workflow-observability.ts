import { fileURLToPath } from "node:url";
import type { InjectedSinks } from "@temporalio/worker";
import type { SpanExporter, SpanLink } from "@space/runtime";
import { logIdentifier } from "./worker-log.js";
import type {
  WorkflowObservabilitySinks,
  WorkflowSpanRecord
} from "./workflow-observability-interceptors.js";

/**
 * Host-side sink for workflow spans emitted by workflow-observability-interceptors.
 * Registered with `callDuringReplay: false` so replaying existing or recorded
 * workflow histories emits zero duplicate spans.
 */
export const workflowObservabilityInterceptorModule = fileURLToPath(
  new URL("./workflow-observability-interceptors.js", import.meta.url)
);

export interface ObserveWorkflowDependencies {
  spans?: SpanExporter | null;
}

const correlationAttributeMap: ReadonlyArray<readonly [string, string]> = [
  ["traceId", "space.trace_id"],
  ["parentTraceId", "space.parent_trace_id"],
  ["roomId", "space.room_id"],
  ["paneId", "space.pane_id"],
  ["missionId", "space.mission_id"],
  ["agentRunId", "space.agent_run_id"],
  ["agentSessionId", "space.agent_session_id"],
  ["actionId", "space.action_id"],
  ["goalId", "space.goal_id"],
  ["dotId", "space.dot_id"],
  ["turnId", "space.turn_id"],
  ["cliTaskId", "space.cli_task_id"],
  ["revisionId", "space.revision_id"],
  ["changeSetId", "space.change_set_id"],
  ["continuationOfRunId", "space.continuation_of_run_id"]
];

export function recordWorkflowSpanToExporter(
  record: WorkflowSpanRecord,
  spans: SpanExporter | null | undefined
): void {
  if (!spans) return;
  const workflowType = logIdentifier(record.workflowType) ?? "unknown";
  const attributes: Record<string, string | number> = {
    "space.workflow_type": workflowType,
    "space.outcome": record.outcome,
    "space.attempt": record.attempt,
    "space.duration_ms": Math.max(0, Math.round(record.durationMs))
  };
  const workflowId = logIdentifier(record.workflowId);
  if (workflowId) attributes["space.workflow_id"] = workflowId;
  const runId = logIdentifier(record.runId);
  if (runId) attributes["space.run_id"] = runId;
  if (record.reasonCode) {
    const code = logIdentifier(record.reasonCode);
    if (code) attributes["space.error_code"] = code;
  }
  if (record.category) {
    const category = logIdentifier(record.category);
    if (category) attributes["space.failure_category"] = category;
  }
  for (const [sourceKey, attrKey] of correlationAttributeMap) {
    const val = logIdentifier(record.correlation?.[sourceKey]);
    if (val) attributes[attrKey] = val;
  }

  const links: SpanLink[] = (record.links ?? []).map((link) => {
    const linkAttrs: Record<string, string | number> = {
      "space.link_kind": link.linkKind
    };
    const contId = logIdentifier(link.continuationOfRunId);
    if (contId) linkAttrs["space.continuation_of_run_id"] = contId;
    return {
      traceId: link.traceId,
      spanId: link.spanId,
      attributes: linkAttrs
    };
  });

  const startMs = Number.isFinite(record.startTimeMs) ? Math.round(record.startTimeMs) : Date.now();
  const durationMs = Number.isFinite(record.durationMs) ? Math.max(0, Math.round(record.durationMs)) : 0;

  spans.record({
    traceId: record.traceId,
    spanId: record.spanId,
    parentSpanId: record.parentSpanId,
    name: `workflow ${workflowType}`,
    startTimeUnixNano: BigInt(startMs) * 1_000_000n,
    endTimeUnixNano: BigInt(startMs + durationMs) * 1_000_000n,
    attributes,
    ...(links.length ? { links } : {}),
    error: record.outcome === "FAILED",
    kind: 1
  });
}

export function createWorkflowObservabilitySinks(
  dependencies: ObserveWorkflowDependencies = {}
): InjectedSinks<WorkflowObservabilitySinks> {
  return {
    workflowObservability: {
      recordWorkflowSpan: {
        fn(_info, record) {
          recordWorkflowSpanToExporter(record, dependencies.spans);
        },
        callDuringReplay: false
      }
    }
  };
}
