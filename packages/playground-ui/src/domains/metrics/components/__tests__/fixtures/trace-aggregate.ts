import type { AggregateTracesResponse, GetObservabilityCapabilitiesResponse } from '@mastra/client-js';

const baseCapabilities: GetObservabilityCapabilitiesResponse = {
  observabilityStorageType: 'ObservabilityStorageDuckDB',
  capabilities: {
    metrics: true,
    logs: true,
    discovery: {
      entityTypes: true,
      entityNames: true,
      serviceNames: true,
      environments: true,
      tags: true,
      metrics: true,
    },
    deltaPolling: true,
    traceQuery: true,
    traceQueryRootDuration: true,
    traceQueryDiscovery: true,
    traceQueryTenantScope: true,
    threadQuery: true,
    spanQuery: true,
    feedback: true,
  },
};

/** A server that answers `aggregateTraces()`, including root span fields. */
export const traceAggregateCapabilities: GetObservabilityCapabilitiesResponse = {
  ...baseCapabilities,
  capabilities: { ...baseCapabilities.capabilities, traceAggregate: true, traceQueryRootSpanFields: true },
};

/** A server from before trace aggregation: no `traceAggregate` capability at all. */
export const olderServerCapabilities: GetObservabilityCapabilitiesResponse = baseCapabilities;

/** Totals with no groupBy: the tokens KPI's current window. */
export const tokenTotalsFixture: AggregateTracesResponse = {
  rows: [{ measures: { 'tokens.input.sum': 9_000, 'tokens.output.sum': 3_000 } }],
  truncated: false,
};

/** The tokens KPI's previous window. */
export const previousTokenTotalsFixture: AggregateTracesResponse = {
  rows: [{ measures: { 'tokens.input.sum': 6_000, 'tokens.output.sum': 2_000 } }],
  truncated: false,
};

/** No usage-bearing traces: token sums are null. */
export const emptyTokenTotalsFixture: AggregateTracesResponse = {
  rows: [{ measures: { 'tokens.input.sum': null, 'tokens.output.sum': null } }],
  truncated: false,
};

export const emptyTraceAggregateFixture: AggregateTracesResponse = { rows: [], truncated: false };

export const traceAggregateErrorFixture = { error: 'Trace aggregation failed' };

const HOUR = 60 * 60 * 1000;

/**
 * Root-type latency over the request's window: two buckets for agents, one for workflows. Bucket
 * starts are whole hours before the window's end, as the server reports them.
 */
export function latencyByRootTypeFixture(timeRange: { to: string }): AggregateTracesResponse {
  const lastHour = Math.floor(Date.parse(timeRange.to) / HOUR) * HOUR;
  const bucket = (hoursAgo: number) => new Date(lastHour - hoursAgo * HOUR).toISOString();
  return {
    rows: [
      {
        dimensions: { spanType: 'agent_run' },
        bucket: bucket(2),
        measures: { 'duration.p50': 120, 'duration.p90': 400, 'duration.p99': 900 },
      },
      {
        dimensions: { spanType: 'agent_run' },
        bucket: bucket(1),
        measures: { 'duration.p50': 150, 'duration.p90': 650, 'duration.p99': 1_400 },
      },
      {
        dimensions: { spanType: 'workflow_run' },
        bucket: bucket(1),
        measures: { 'duration.p50': 1_000, 'duration.p90': 2_500, 'duration.p99': 4_000 },
      },
    ],
    truncated: false,
  };
}

/**
 * One grouped request for the top-entities card: `ingest` is slowest, `writer` fails most and
 * costs most (partly priced), `researcher` is in between, `triage` used two currencies. `triage`
 * comes before `writer` and ties its error rate, so only the error-count tie-break ranks `writer` first.
 */
export const topEntitiesFixture: AggregateTracesResponse = {
  rows: [
    {
      dimensions: { entityType: 'workflow_run', entityName: 'ingest' },
      measures: { count: 300, errorRate: 0, errorCount: 0, 'duration.p95': 12_000, 'cost.sum': null },
      cost: { coverage: null, unit: null },
    },
    {
      dimensions: { entityType: 'agent', entityName: 'researcher' },
      measures: { count: 100, errorRate: 0.02, errorCount: 2, 'duration.p95': 3_000, 'cost.sum': 1.2 },
      cost: { coverage: 1, unit: 'usd' },
    },
    {
      dimensions: { entityType: 'agent', entityName: 'triage' },
      measures: { count: 20, errorRate: 0.1, errorCount: 2, 'duration.p95': 500, 'cost.sum': 9 },
      cost: { coverage: 1, unit: 'mixed' },
    },
    {
      dimensions: { entityType: 'agent', entityName: 'writer' },
      measures: { count: 50, errorRate: 0.1, errorCount: 5, 'duration.p95': 800, 'cost.sum': 4.5 },
      cost: { coverage: 0.5, unit: 'usd' },
    },
  ],
  truncated: false,
};
