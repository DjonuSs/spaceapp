import {
  ContinueAsNew,
  defaultPayloadConverter,
  isCancellation,
  proxySinks,
  workflowInfo,
  type Headers,
  type Sinks,
  type WorkflowInterceptorsFactory
} from "@temporalio/workflow";
import {
  categorizeFailureCode,
  deterministicSpanId,
  deterministicTraceId,
  formatTraceparent,
  isSafeErrorCode,
  parseTraceparent,
  type FailureCategory
} from "@space/contracts";

export interface WorkflowSpanLinkRecord {
  traceId: string;
  spanId: string;
  linkKind: "continue_as_new" | "background_continuation";
  continuationOfRunId?: string;
}

export interface WorkflowSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  workflowType: string;
  workflowId: string;
  runId: string;
  attempt: number;
  outcome: "COMPLETED" | "FAILED" | "CANCELLED" | "CONTINUED_AS_NEW";
  reasonCode: string | null;
  category: FailureCategory | null;
  startTimeMs: number;
  durationMs: number;
  correlation: Record<string, string>;
  links: WorkflowSpanLinkRecord[];
}

export interface WorkflowObservabilitySinks extends Sinks {
  workflowObservability: {
    recordWorkflowSpan(record: WorkflowSpanRecord): void;
  };
}

const { workflowObservability } = proxySinks<WorkflowObservabilitySinks>();

export const SPACE_TRACEPARENT_HEADER = "x-space-traceparent";
export const SPACE_LINK_TRACEPARENT_HEADER = "x-space-link-traceparent";
export const SPACE_LINK_KIND_HEADER = "x-space-link-kind";
export const SPACE_CONTINUATION_OF_RUN_ID_HEADER = "x-space-continuation-of-run-id";
export const SPACE_TRACE_ID_HEADER = "x-space-trace-id";
export const SPACE_PARENT_TRACE_ID_HEADER = "x-space-parent-trace-id";
export const SPACE_GOAL_ID_HEADER = "x-space-goal-id";
export const SPACE_MISSION_ID_HEADER = "x-space-mission-id";
export const SPACE_ROOM_ID_HEADER = "x-space-room-id";
export const SPACE_PANE_ID_HEADER = "x-space-pane-id";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,239}$/;

function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && identifierPattern.test(value) && !value.includes("..") ? value : null;
}

const correlationKeys = [
  "traceId",
  "traceparent",
  "requestId",
  "roomId",
  "paneId",
  "missionId",
  "roomAgentMissionId",
  "agentRunId",
  "agentSessionId",
  "actionId",
  "goalId",
  "dotId",
  "turnId",
  "cliTaskId",
  "revisionId",
  "changeSetId"
] as const;

type CorrelationKey = (typeof correlationKeys)[number];

const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;

interface ExtractedCorrelation {
  fields: Partial<Record<CorrelationKey, string>>;
  continuationSourceRunId: string | null;
}

function readCorrelationValue(value: unknown, into: ExtractedCorrelation, depth: number): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (depth > 0 && value.length > 0) readCorrelationValue(value[0], into, depth - 1);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of correlationKeys) {
    if (into.fields[key] !== undefined) continue;
    if (key === "traceparent") {
      const parsed = parseTraceparent(record[key]);
      if (parsed) into.fields.traceparent = formatTraceparent(parsed.traceId, parsed.parentId, parsed.flags);
      continue;
    }
    const id = safeIdentifier(record[key]);
    if (id !== null) into.fields[key] = id;
  }
  if (into.continuationSourceRunId === null && record.roomAgentContinuation && typeof record.roomAgentContinuation === "object") {
    const sourceRunId = safeIdentifier((record.roomAgentContinuation as Record<string, unknown>).sourceRunId);
    if (sourceRunId) into.continuationSourceRunId = sourceRunId;
  }
  if (depth <= 0) return;
  for (const key of nestedKeys) {
    readCorrelationValue(record[key], into, depth - 1);
  }
  if (Array.isArray(record.pending) && record.pending.length > 0) {
    readCorrelationValue(record.pending[0], into, depth - 1);
  }
}

function extractCorrelation(args: readonly unknown[]): ExtractedCorrelation {
  const into: ExtractedCorrelation = { fields: {}, continuationSourceRunId: null };
  for (const arg of args) readCorrelationValue(arg, into, 3);
  return into;
}

function readHeaderString(headers: Headers | undefined, key: string): string | null {
  const payload = headers?.[key];
  if (!payload) return null;
  try {
    const decoded = defaultPayloadConverter.fromPayload(payload);
    return typeof decoded === "string" ? decoded : null;
  } catch {
    return null;
  }
}

function readMemoString(memo: Record<string, unknown> | undefined, key: string): string | null {
  const raw = memo?.[key];
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "data" in raw) {
    try {
      const decoded = defaultPayloadConverter.fromPayload(raw as never);
      return typeof decoded === "string" ? decoded : null;
    } catch {
      return null;
    }
  }
  return null;
}

function workflowErrorCode(error: unknown): string {
  const record = error as { code?: unknown; type?: unknown; name?: unknown; cause?: unknown } | null;
  if (isSafeErrorCode(record?.code)) return record!.code as string;
  if (isSafeErrorCode(record?.type)) return record!.type as string;
  const cause = record?.cause as { code?: unknown; type?: unknown; name?: unknown } | null;
  if (isSafeErrorCode(cause?.code)) return cause!.code as string;
  if (isSafeErrorCode(cause?.type)) return cause!.type as string;
  const name = typeof record?.name === "string" ? record.name : "";
  if (/Cancel/i.test(name)) return "WORKFLOW_CANCELLED";
  if (/Timeout/i.test(name)) return "WORKFLOW_TIMEOUT";
  if (/ChildWorkflow/i.test(name)) return "CHILD_WORKFLOW_FAILED";
  if (/Activity/i.test(name)) return "WORKFLOW_ACTIVITY_FAILED";
  return "WORKFLOW_FAILED";
}

function buildCorrelationAttributes(
  extracted: ExtractedCorrelation,
  headers: Headers | undefined,
  memo: Record<string, unknown> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  const traceId =
    extracted.fields.traceId ??
    safeIdentifier(readHeaderString(headers, SPACE_TRACE_ID_HEADER)) ??
    safeIdentifier(readMemoString(memo, "spaceTraceId"));
  if (traceId) out.traceId = traceId;

  const parentTraceId =
    (extracted.fields.requestId && extracted.fields.requestId !== traceId ? extracted.fields.requestId : null) ??
    safeIdentifier(readHeaderString(headers, SPACE_PARENT_TRACE_ID_HEADER)) ??
    safeIdentifier(readMemoString(memo, "parentSpaceTraceId"));
  if (parentTraceId) out.parentTraceId = parentTraceId;

  const missionId =
    extracted.fields.missionId ??
    extracted.fields.roomAgentMissionId ??
    safeIdentifier(readHeaderString(headers, SPACE_MISSION_ID_HEADER)) ??
    safeIdentifier(readMemoString(memo, "missionId"));
  if (missionId) out.missionId = missionId;

  const goalId = extracted.fields.goalId ?? safeIdentifier(readHeaderString(headers, SPACE_GOAL_ID_HEADER));
  if (goalId) out.goalId = goalId;

  const roomId = extracted.fields.roomId ?? safeIdentifier(readHeaderString(headers, SPACE_ROOM_ID_HEADER));
  if (roomId) out.roomId = roomId;

  const paneId = extracted.fields.paneId ?? safeIdentifier(readHeaderString(headers, SPACE_PANE_ID_HEADER));
  if (paneId) out.paneId = paneId;

  for (const key of ["agentRunId", "agentSessionId", "actionId", "dotId", "turnId", "cliTaskId", "revisionId", "changeSetId"] as const) {
    if (extracted.fields[key]) out[key] = extracted.fields[key]!;
  }
  const continuationOfRunId =
    extracted.continuationSourceRunId ??
    safeIdentifier(readHeaderString(headers, SPACE_CONTINUATION_OF_RUN_ID_HEADER));
  if (continuationOfRunId) out.continuationOfRunId = continuationOfRunId;
  return out;
}

const supervisorTurnTerminalActivities = new Set([
  "finishRoomAgentSupervisorTurn",
  "markRoomAgentMissionFinished",
  "markRoomAgentMissionContinued"
]);

export const interceptors: WorkflowInterceptorsFactory = () => {
  const info = workflowInfo();
  const baseSpanId = deterministicSpanId(`workflow:${info.workflowId}:${info.runId}`);
  let currentSpanId = baseSpanId;
  let traceId: string = deterministicTraceId(info.workflowId);
  let parentSpanId: string | null = info.parent
    ? deterministicSpanId(`workflow:${info.parent.workflowId}:${info.parent.runId}`)
    : null;
  let hasExplicitTraceparent = false;
  let correlation: Record<string, string> = {};
  let links: WorkflowSpanLinkRecord[] = [];
  let startTimeMs = info.unsafe.now();
  let spanRecordedForRun = false;
  let supervisorProcessedCount = 0;

  function applyInputs(args: readonly unknown[], headers?: Headers): void {
    const extracted = extractCorrelation(args);
    const mergedCorrelation = buildCorrelationAttributes(extracted, headers, info.memo);
    correlation = { ...correlation, ...mergedCorrelation };

    const headerTp = parseTraceparent(
      readHeaderString(headers, SPACE_TRACEPARENT_HEADER) ?? readHeaderString(headers, "traceparent")
    );
    const memoTp = parseTraceparent(readMemoString(info.memo, "traceparent"));
    const argTp = parseTraceparent(extracted.fields.traceparent);
    const chosen = headerTp ?? memoTp ?? argTp;

    if (chosen && !hasExplicitTraceparent) {
      traceId = chosen.traceId;
      parentSpanId = chosen.parentId;
      hasExplicitTraceparent = true;
    } else if (!hasExplicitTraceparent && correlation.traceId) {
      traceId = deterministicTraceId(correlation.traceId);
    }

    const linkTp = parseTraceparent(readHeaderString(headers, SPACE_LINK_TRACEPARENT_HEADER));
    const linkKindRaw = readHeaderString(headers, SPACE_LINK_KIND_HEADER);
    const linkContinuationRunId =
      safeIdentifier(readHeaderString(headers, SPACE_CONTINUATION_OF_RUN_ID_HEADER)) ??
      extracted.continuationSourceRunId ??
      safeIdentifier(info.continuedFromExecutionRunId);

    if (linkTp && (linkKindRaw === "continue_as_new" || linkKindRaw === "background_continuation")) {
      if (!links.some((l) => l.traceId === linkTp.traceId && l.spanId === linkTp.parentId)) {
        links.push({
          traceId: linkTp.traceId,
          spanId: linkTp.parentId,
          linkKind: linkKindRaw,
          ...(linkContinuationRunId ? { continuationOfRunId: linkContinuationRunId } : {})
        });
      }
    } else if (info.continuedFromExecutionRunId && !links.some((l) => l.linkKind === "continue_as_new")) {
      const prevSpanId = deterministicSpanId(`workflow:${info.workflowId}:${info.continuedFromExecutionRunId}`);
      links.push({
        traceId,
        spanId: prevSpanId,
        linkKind: "continue_as_new",
        continuationOfRunId: info.continuedFromExecutionRunId
      });
      if (!parentSpanId) parentSpanId = prevSpanId;
    } else if (extracted.continuationSourceRunId && argTp && !links.some((l) => l.linkKind === "background_continuation")) {
      links.push({
        traceId: argTp.traceId,
        spanId: argTp.parentId,
        linkKind: "background_continuation",
        continuationOfRunId: extracted.continuationSourceRunId
      });
    }
  }

  function buildPropagationHeaders(
    existingHeaders: Headers,
    overrides?: {
      traceparentSpanId?: string;
      linkTraceparent?: string | null;
      linkKind?: "continue_as_new" | "background_continuation" | null;
      continuationOfRunId?: string | null;
      extraCorrelation?: Record<string, string>;
    }
  ): Headers {
    const nextHeaders: Headers = { ...existingHeaders };
    const effectiveCorrelation = { ...correlation, ...overrides?.extraCorrelation };
    const parentIdForChild = overrides?.traceparentSpanId ?? currentSpanId;
    nextHeaders[SPACE_TRACEPARENT_HEADER] = defaultPayloadConverter.toPayload(
      formatTraceparent(traceId, parentIdForChild, "01")
    );
    if (effectiveCorrelation.traceId) {
      nextHeaders[SPACE_TRACE_ID_HEADER] = defaultPayloadConverter.toPayload(effectiveCorrelation.traceId);
    }
    if (effectiveCorrelation.parentTraceId) {
      nextHeaders[SPACE_PARENT_TRACE_ID_HEADER] = defaultPayloadConverter.toPayload(effectiveCorrelation.parentTraceId);
    }
    if (effectiveCorrelation.goalId) {
      nextHeaders[SPACE_GOAL_ID_HEADER] = defaultPayloadConverter.toPayload(effectiveCorrelation.goalId);
    }
    if (effectiveCorrelation.missionId) {
      nextHeaders[SPACE_MISSION_ID_HEADER] = defaultPayloadConverter.toPayload(effectiveCorrelation.missionId);
    }
    if (effectiveCorrelation.roomId) {
      nextHeaders[SPACE_ROOM_ID_HEADER] = defaultPayloadConverter.toPayload(effectiveCorrelation.roomId);
    }
    if (effectiveCorrelation.paneId) {
      nextHeaders[SPACE_PANE_ID_HEADER] = defaultPayloadConverter.toPayload(effectiveCorrelation.paneId);
    }

    const linkTp = overrides?.linkTraceparent ?? (links[0] ? formatTraceparent(links[0].traceId, links[0].spanId, "01") : null);
    const linkKind = overrides?.linkKind ?? links[0]?.linkKind ?? null;
    const continuationRunId = overrides?.continuationOfRunId ?? effectiveCorrelation.continuationOfRunId ?? links[0]?.continuationOfRunId ?? null;
    if (linkTp && linkKind) {
      nextHeaders[SPACE_LINK_TRACEPARENT_HEADER] = defaultPayloadConverter.toPayload(linkTp);
      nextHeaders[SPACE_LINK_KIND_HEADER] = defaultPayloadConverter.toPayload(linkKind);
    }
    if (continuationRunId) {
      nextHeaders[SPACE_CONTINUATION_OF_RUN_ID_HEADER] = defaultPayloadConverter.toPayload(continuationRunId);
    }
    return nextHeaders;
  }

  function emitSpan(
    outcome: WorkflowSpanRecord["outcome"],
    reasonCode: string | null = null,
    category: FailureCategory | null = null
  ): void {
    if (spanRecordedForRun) return;
    spanRecordedForRun = true;
    const nowMs = info.unsafe.now();
    workflowObservability.recordWorkflowSpan({
      traceId,
      spanId: currentSpanId,
      parentSpanId,
      workflowType: info.workflowType,
      workflowId: info.workflowId,
      runId: info.runId,
      attempt: info.attempt,
      outcome,
      reasonCode,
      category,
      startTimeMs,
      durationMs: Math.max(0, nowMs - startTimeMs),
      correlation: { ...correlation },
      links: [...links]
    });
  }

  return {
    inbound: [
      {
        async execute(input, next) {
          startTimeMs = info.unsafe.now();
          const firstArg = input.args[0] as { processedCount?: unknown } | undefined;
          if (firstArg && typeof firstArg === "object" && typeof firstArg.processedCount === "number") {
            supervisorProcessedCount = firstArg.processedCount;
          }
          applyInputs(input.args, input.headers);
          try {
            const result = await next(input);
            emitSpan("COMPLETED");
            return result;
          } catch (error) {
            if (error instanceof ContinueAsNew) {
              emitSpan("CONTINUED_AS_NEW");
            } else if (isCancellation(error)) {
              emitSpan("CANCELLED", "WORKFLOW_CANCELLED", "CANCELLED");
            } else {
              const code = workflowErrorCode(error);
              emitSpan("FAILED", code, categorizeFailureCode(code));
            }
            throw error;
          }
        },
        async handleSignal(input, next) {
          applyInputs(input.args, input.headers);
          return next(input);
        }
      }
    ],
    outbound: [
      {
        async scheduleActivity(input, next) {
          const argExtracted = extractCorrelation(input.args);
          const extraCorrelation = buildCorrelationAttributes(argExtracted, undefined, undefined);
          if (argExtracted.fields.traceparent && !hasExplicitTraceparent) {
            const parsed = parseTraceparent(argExtracted.fields.traceparent);
            if (parsed) {
              traceId = parsed.traceId;
              parentSpanId = parsed.parentId;
              hasExplicitTraceparent = true;
            }
          }
          correlation = { ...correlation, ...extraCorrelation };
          const headers = buildPropagationHeaders(input.headers, { extraCorrelation });
          const result = await next({ ...input, headers });
          if (
            info.workflowType === "roomAgentSupervisorWorkflow" &&
            supervisorTurnTerminalActivities.has(input.activityType)
          ) {
            supervisorProcessedCount += 1;
            if (supervisorProcessedCount < 50) {
              emitSpan("COMPLETED");
            }
          }
          return result;
        },
        async startChildWorkflowExecution(input, next) {
          const childArgs = input.options.args ?? [];
          const childExtracted = extractCorrelation(childArgs);
          const extraCorrelation = buildCorrelationAttributes(childExtracted, undefined, undefined);
          const childTp = parseTraceparent(childExtracted.fields.traceparent);
          if (childTp && !hasExplicitTraceparent) {
            traceId = childTp.traceId;
            parentSpanId = childTp.parentId;
            hasExplicitTraceparent = true;
          }
          correlation = { ...correlation, ...extraCorrelation };
          const isBackgroundContinuation = Boolean(
            childExtracted.continuationSourceRunId ||
            (extraCorrelation.traceId && extraCorrelation.traceId.startsWith("trace:bg-"))
          );
          const linkTraceparent = isBackgroundContinuation
            ? (childTp ? formatTraceparent(childTp.traceId, childTp.parentId, childTp.flags) : formatTraceparent(traceId, currentSpanId, "01"))
            : null;
          const headers = buildPropagationHeaders(input.headers, {
            extraCorrelation,
            linkTraceparent,
            linkKind: isBackgroundContinuation ? "background_continuation" : null,
            continuationOfRunId: childExtracted.continuationSourceRunId
          });
          return next({ ...input, headers });
        },
        async continueAsNew(input, next) {
          const linkTp = formatTraceparent(traceId, currentSpanId, "01");
          const headers = buildPropagationHeaders(input.headers, {
            traceparentSpanId: currentSpanId,
            linkTraceparent: linkTp,
            linkKind: "continue_as_new",
            continuationOfRunId: info.runId
          });
          emitSpan("CONTINUED_AS_NEW");
          return next({ ...input, headers });
        }
      }
    ]
  };
};
