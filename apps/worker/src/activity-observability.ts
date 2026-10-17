import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { Context } from "@temporalio/activity";
import { defaultPayloadConverter, type Headers } from "@temporalio/common";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import {
  categorizeFailureCode,
  formatTraceparent,
  isSafeErrorCode,
  parseTraceparent,
  traceIdFromTraceparent,
  type FailureCategory,
  type ParsedTraceparent
} from "@space/contracts";
import type { SpanExporter, SpanLink } from "@space/runtime";
import { logIdentifier, workerLog, type WorkerLogValue } from "./worker-log.js";
import { workerMetrics, type WorkerMetrics } from "./worker-metrics.js";
import {
  SPACE_CONTINUATION_OF_RUN_ID_HEADER,
  SPACE_GOAL_ID_HEADER,
  SPACE_LINK_KIND_HEADER,
  SPACE_LINK_TRACEPARENT_HEADER,
  SPACE_MISSION_ID_HEADER,
  SPACE_PANE_ID_HEADER,
  SPACE_PARENT_TRACE_ID_HEADER,
  SPACE_ROOM_ID_HEADER,
  SPACE_TRACEPARENT_HEADER,
  SPACE_TRACE_ID_HEADER
} from "./workflow-observability-interceptors.js";

/**
 * One structured start/finish record and metrics per activity execution, with
 * the correlation ids the API put into the workflow input. Runs in the worker
 * process (activity interceptor), never inside the deterministic workflow
 * sandbox, so it cannot affect replay.
 */

type ActivityInfo = Pick<
  Context["info"],
  "activityType" | "attempt" | "workflowExecution" | "workflowType" | "currentAttemptScheduledTimestampMs" | "activityId"
>;

export type ActivityOutcome = "COMPLETED" | "FAILED_RESULT" | "FAILED" | "CANCELLED";

interface ActivityObservation {
  reasonCode: string | null;
  activeTraceparent: ParsedTraceparent | null;
}

const observations = new AsyncLocalStorage<ActivityObservation>();

function randomSpanId(): string {
  for (;;) {
    const id = randomBytes(8).toString("hex");
    if (!/^0+$/.test(id)) return id;
  }
}

/**
 * Called by failure recorders (for example recordCodexAppServerTurnFailure)
 * that return a FAILED result instead of throwing, so the activity record
 * carries the causal reason code. A no-op outside an observed activity.
 */
export function noteActivityFailureReason(reasonCode: string): void {
  const observation = observations.getStore();
  if (observation && isSafeErrorCode(reasonCode)) observation.reasonCode = reasonCode;
}

/**
 * Runs `execute` inside a failure-reason scope, reusing the activity's scope
 * when the interceptor already opened one, and exposes the noted reason code.
 */
export function failureReasonScope<T>(execute: () => Promise<T>): { promise: Promise<T>; reasonCode: () => string | null } {
  const existing = observations.getStore();
  if (existing) return { promise: execute(), reasonCode: () => existing.reasonCode };
  const observation: ActivityObservation = { reasonCode: null, activeTraceparent: null };
  return { promise: observations.run(observation, execute), reasonCode: () => observation.reasonCode };
}

/** traceparent for an outbound call: uses the active activity span when in the same trace, otherwise a new child span id. */
export function childTraceparent(traceparent: string | null | undefined): string | null {
  const parsed = parseTraceparent(traceparent);
  if (!parsed) return null;
  const active = observations.getStore()?.activeTraceparent;
  if (active && active.traceId === parsed.traceId) {
    return formatTraceparent(active.traceId, active.parentId, active.flags);
  }
  return formatTraceparent(parsed.traceId, randomSpanId(), parsed.flags);
}

// Keys whose values are identifiers. Prompts, content and messages are never read.
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
const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;

type CorrelationKey = (typeof correlationKeys)[number];

function readCorrelation(value: unknown, into: Partial<Record<CorrelationKey, string>>, depth: number): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const key of correlationKeys) {
    if (into[key] !== undefined) continue;
    const identifier = logIdentifier(record[key]);
    if (identifier !== null) into[key] = identifier;
  }
  if (depth <= 0) return;
  for (const key of nestedKeys) readCorrelation(record[key], into, depth - 1);
}

function readContinuationSourceRunId(value: unknown, depth: number): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.roomAgentContinuation && typeof record.roomAgentContinuation === "object") {
    const sourceRunId = logIdentifier((record.roomAgentContinuation as Record<string, unknown>).sourceRunId);
    if (sourceRunId) return sourceRunId;
  }
  if (depth <= 0) return null;
  for (const key of nestedKeys) {
    const nested = readContinuationSourceRunId(record[key], depth - 1);
    if (nested) return nested;
  }
  return null;
}

/** Allowlisted correlation fields from activity arguments (identifiers only). */
export function activityCorrelation(args: readonly unknown[]): Record<string, string> {
  const found: Partial<Record<CorrelationKey, string>> = {};
  for (const arg of args) readCorrelation(arg, found, 2);
  const correlation: Record<string, string> = {};
  if (found.traceId) correlation.traceId = found.traceId;
  const w3cTraceId = traceIdFromTraceparent(found.traceparent);
  if (w3cTraceId) correlation.w3cTraceId = w3cTraceId;
  if (found.requestId && found.requestId !== found.traceId) correlation.parentTraceId = found.requestId;
  const missionId = found.missionId ?? found.roomAgentMissionId;
  if (missionId) correlation.missionId = missionId;
  for (const key of ["roomId", "paneId", "agentRunId", "agentSessionId", "actionId", "goalId", "dotId", "turnId", "cliTaskId", "revisionId"] as const) {
    if (found[key]) correlation[key] = found[key]!;
  }
  return correlation;
}

function errorCodeOf(error: unknown): string {
  const record = error as { code?: unknown; type?: unknown; name?: unknown } | null;
  if (isSafeErrorCode(record?.code)) return record!.code as string;
  if (isSafeErrorCode(record?.type)) return record!.type as string;
  const name = typeof record?.name === "string" ? record.name : "";
  if (/Cancel/i.test(name)) return "ACTIVITY_CANCELLED";
  if (/Timeout/i.test(name)) return "ACTIVITY_TIMEOUT";
  if (/NotFound/i.test(name)) return "STATE_NOT_FOUND";
  if (/Retryable/i.test(name)) return "UPSTREAM_RETRYABLE_UNAVAILABLE";
  return "ACTIVITY_ERROR";
}

function isFailedResult(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { status?: unknown }).status === "FAILED");
}

export interface ObserveActivityDependencies {
  metrics?: WorkerMetrics;
  now?: () => number;
  cancelled?: () => boolean;
  /** OTLP export (SPACE_OTEL_EXPORTER_OTLP_ENDPOINT): one span per activity whose input or workflow header carries a traceparent. */
  spans?: SpanExporter | null;
  headers?: Headers;
}

function readHeaderString(headers: Headers | undefined, key: string): string | null {
  const payload = headers?.[key];
  if (!payload) return null;
  if (typeof (payload as unknown) === "string") return payload as unknown as string;
  try {
    const decoded = defaultPayloadConverter.fromPayload(payload);
    return typeof decoded === "string" ? decoded : null;
  } catch {
    return null;
  }
}

function activityTraceparent(args: readonly unknown[], headers?: Headers) {
  const headerTp = parseTraceparent(
    readHeaderString(headers, SPACE_TRACEPARENT_HEADER) ?? readHeaderString(headers, "traceparent")
  );
  if (headerTp) return headerTp;
  const found: Partial<Record<CorrelationKey, string>> = {};
  for (const arg of args) readCorrelation(arg, found, 2);
  return parseTraceparent(found.traceparent);
}

const spanCorrelationAttributeMap: ReadonlyArray<readonly [string, string]> = [
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
  ["revisionId", "space.revision_id"]
];

export async function observeActivityExecution<T>(
  info: ActivityInfo,
  args: readonly unknown[],
  execute: () => Promise<T>,
  dependencies: ObserveActivityDependencies = {}
): Promise<T> {
  const metrics = dependencies.metrics ?? workerMetrics;
  const now = dependencies.now ?? Date.now;
  const activityType = logIdentifier(info.activityType) ?? "unknown";
  const startedAt = now();
  const queueMs = Number.isFinite(info.currentAttemptScheduledTimestampMs)
    ? Math.max(0, startedAt - info.currentAttemptScheduledTimestampMs)
    : null;
  const correlation = activityCorrelation(args);
  const parent = activityTraceparent(args, dependencies.headers);
  const attemptSpanId = randomSpanId();
  const base: Record<string, WorkerLogValue> = {
    activityType,
    activityId: info.activityId,
    workflowType: info.workflowType ?? null,
    workflowId: info.workflowExecution?.workflowId ?? null,
    temporalRunId: info.workflowExecution?.runId ?? null,
    attempt: info.attempt,
    ...correlation
  };
  const labels = { activity_type: activityType };
  if (info.attempt > 1) metrics.activityRetries.inc(labels);
  if (queueMs !== null) metrics.activityScheduleToStart.observe(labels, queueMs / 1000);
  metrics.activitiesInFlight.inc(labels);
  workerLog("info", "activity.started", { ...base, queueMs });
  const observation: ActivityObservation = {
    reasonCode: null,
    activeTraceparent: parent ? { traceId: parent.traceId, parentId: attemptSpanId, flags: parent.flags } : null
  };

  const finish = (outcome: ActivityOutcome, reasonCode: string | null, errorName: string | null) => {
    const durationMs = Math.max(0, now() - startedAt);
    metrics.activitiesInFlight.inc(labels, -1);
    metrics.activityExecutions.inc({ activity_type: activityType, outcome });
    metrics.activityDuration.observe(labels, durationMs / 1000);
    let category: FailureCategory | null = null;
    if (outcome !== "COMPLETED") {
      category = outcome === "CANCELLED" ? "CANCELLED" : categorizeFailureCode(reasonCode);
      metrics.activityFailures.inc({ activity_type: activityType, category, code: reasonCode ?? "UNSPECIFIED" });
    }
    workerLog(outcome === "COMPLETED" ? "info" : outcome === "CANCELLED" ? "warn" : "error", "activity.finished", {
      ...base,
      outcome,
      reasonCode,
      category,
      errorName,
      durationMs,
      queueMs,
      rssBytes: process.memoryUsage().rss
    });
    if (dependencies.spans && parent) {
      const attributes: Record<string, string | number> = {
        "space.activity_type": activityType,
        "space.outcome": outcome,
        "space.attempt": info.attempt,
        "space.duration_ms": durationMs
      };
      if (queueMs !== null) attributes["space.queue_ms"] = queueMs;
      const activityId = logIdentifier(info.activityId);
      if (activityId) attributes["space.activity_id"] = activityId;
      const workflowType = logIdentifier(info.workflowType);
      if (workflowType) attributes["space.workflow_type"] = workflowType;
      const workflowId = logIdentifier(info.workflowExecution?.workflowId);
      if (workflowId) attributes["space.workflow_id"] = workflowId;
      const runId = logIdentifier(info.workflowExecution?.runId);
      if (runId) attributes["space.run_id"] = runId;
      if (reasonCode && logIdentifier(reasonCode)) attributes["space.error_code"] = reasonCode;
      if (category && logIdentifier(category)) attributes["space.failure_category"] = category;

      const mergedCorrelation: Record<string, string> = { ...correlation };
      const headerTraceId = logIdentifier(readHeaderString(dependencies.headers, SPACE_TRACE_ID_HEADER));
      if (!mergedCorrelation.traceId && headerTraceId) mergedCorrelation.traceId = headerTraceId;
      const headerParentTraceId = logIdentifier(readHeaderString(dependencies.headers, SPACE_PARENT_TRACE_ID_HEADER));
      if (!mergedCorrelation.parentTraceId && headerParentTraceId) mergedCorrelation.parentTraceId = headerParentTraceId;
      const headerGoalId = logIdentifier(readHeaderString(dependencies.headers, SPACE_GOAL_ID_HEADER));
      if (!mergedCorrelation.goalId && headerGoalId) mergedCorrelation.goalId = headerGoalId;
      const headerMissionId = logIdentifier(readHeaderString(dependencies.headers, SPACE_MISSION_ID_HEADER));
      if (!mergedCorrelation.missionId && headerMissionId) mergedCorrelation.missionId = headerMissionId;
      const headerRoomId = logIdentifier(readHeaderString(dependencies.headers, SPACE_ROOM_ID_HEADER));
      if (!mergedCorrelation.roomId && headerRoomId) mergedCorrelation.roomId = headerRoomId;
      const headerPaneId = logIdentifier(readHeaderString(dependencies.headers, SPACE_PANE_ID_HEADER));
      if (!mergedCorrelation.paneId && headerPaneId) mergedCorrelation.paneId = headerPaneId;

      for (const [sourceKey, attrKey] of spanCorrelationAttributeMap) {
        const val = logIdentifier(mergedCorrelation[sourceKey]);
        if (val) attributes[attrKey] = val;
      }

      const foundExtra: Partial<Record<CorrelationKey, string>> = {};
      let continuationSourceRunId: string | null = logIdentifier(
        readHeaderString(dependencies.headers, SPACE_CONTINUATION_OF_RUN_ID_HEADER)
      );
      for (const arg of args) {
        readCorrelation(arg, foundExtra, 2);
        if (!continuationSourceRunId) continuationSourceRunId = readContinuationSourceRunId(arg, 2);
      }
      if (foundExtra.changeSetId) attributes["space.change_set_id"] = foundExtra.changeSetId;
      if (continuationSourceRunId) attributes["space.continuation_of_run_id"] = continuationSourceRunId;

      const links: SpanLink[] = [];
      const linkTp = parseTraceparent(readHeaderString(dependencies.headers, SPACE_LINK_TRACEPARENT_HEADER));
      const linkKind = readHeaderString(dependencies.headers, SPACE_LINK_KIND_HEADER);
      if (linkTp && (linkKind === "continue_as_new" || linkKind === "background_continuation")) {
        links.push({
          traceId: linkTp.traceId,
          spanId: linkTp.parentId,
          attributes: {
            "space.link_kind": linkKind,
            ...(continuationSourceRunId ? { "space.continuation_of_run_id": continuationSourceRunId } : {})
          }
        });
      } else if (continuationSourceRunId && foundExtra.traceparent) {
        const argTp = parseTraceparent(foundExtra.traceparent);
        if (argTp) {
          links.push({
            traceId: argTp.traceId,
            spanId: argTp.parentId,
            attributes: {
              "space.link_kind": "background_continuation",
              "space.continuation_of_run_id": continuationSourceRunId
            }
          });
        }
      }

      dependencies.spans.record({
        traceId: parent.traceId,
        spanId: attemptSpanId,
        parentSpanId: parent.parentId,
        name: `activity ${activityType}`,
        startTimeUnixNano: BigInt(startedAt) * 1_000_000n,
        endTimeUnixNano: BigInt(startedAt + durationMs) * 1_000_000n,
        attributes,
        ...(links.length ? { links } : {}),
        error: outcome === "FAILED" || outcome === "FAILED_RESULT",
        kind: 1
      });
    }
  };

  try {
    const result = await observations.run(observation, execute);
    if (isFailedResult(result)) finish("FAILED_RESULT", observation.reasonCode ?? "ACTIVITY_RESULT_FAILED", null);
    else finish("COMPLETED", null, null);
    return result;
  } catch (error) {
    const cancelled = dependencies.cancelled?.() === true || /Cancel/i.test((error as { name?: string } | null)?.name ?? "");
    const errorName = logIdentifier((error as { name?: unknown } | null)?.name);
    finish(cancelled ? "CANCELLED" : "FAILED", observation.reasonCode ?? errorCodeOf(error), errorName);
    throw error;
  }
}

/** Temporal worker interceptor factory: register in Worker.create({ interceptors }). */
export function createActivityObservabilityInterceptors(dependencies: Omit<ObserveActivityDependencies, "cancelled" | "headers"> = {}): ActivityInterceptorsFactory {
  return (context) => ({
    inbound: {
      execute: (input, next) => observeActivityExecution(context.info, input.args, () => next(input), {
        ...dependencies,
        headers: input.headers,
        cancelled: () => context.cancellationSignal.aborted
      })
    }
  });
}

