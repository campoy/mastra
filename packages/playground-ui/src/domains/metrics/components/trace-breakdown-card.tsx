import type { AggregateTracesArgs, AggregateTracesResponse } from '@mastra/client-js';
import { useState } from 'react';
import type { DrilldownScope } from '../drilldown';
import { useMetricsTraceAggregate } from '../hooks/use-metrics-trace-aggregate';
import type { TraceAggregateScope } from '../hooks/use-metrics-trace-aggregate';
import { formatCount, formatPercent } from '../lib/chart-format';
import { ChartArea } from './chart-area';
import { ChartCard } from './chart-card';
import { ChartCardError } from './chart-card-error';
import { TraceAggregateCard } from './trace-aggregate-card';
import { MetricsCard } from '@/ds/components/MetricsCard';
import { NUM, ROW } from '@/ds/components/MetricsShareList/metrics-share-list-classes';
import { Txt } from '@/ds/components/Txt';
import { formatAggregateCost } from '@/lib/cost';
import { cn } from '@/lib/utils';

type Dimension = 'environment' | 'executionSource';
type Row = AggregateTracesResponse['rows'][number];

/** Environments and execution sources are few; this keeps the list bounded if a store has many. */
export const TRACE_BREAKDOWN_LIMIT = 50;

const MEASURES: AggregateTracesArgs['measures'] = ['count', 'errorRate', 'cost.sum'];
const COLUMNS = ['Traces', 'Error rate', 'Cost'];

const TITLE = 'Trace breakdown';
const DESCRIPTION = 'Trace count, error rate and cost per environment or execution source.';

export type TraceBreakdownCardProps = {
  /** Called with the clicked environment. Execution sources have no Traces filter, so they aren't clickable. */
  onEnvironmentClick?: (scope: DrilldownScope) => void;
};

/** Traces split by environment or execution source; one request, for the open tab only. */
export function TraceBreakdownCard(props: TraceBreakdownCardProps) {
  const [dimension, setDimension] = useState<Dimension>('environment');
  return (
    <TraceAggregateCard title={TITLE} description={DESCRIPTION}>
      {scope => (
        // Keyed so a tab switch loads fresh instead of showing the other tab's rows as placeholders.
        <TraceBreakdownList
          key={dimension}
          scope={scope}
          dimension={dimension}
          onDimensionChange={setDimension}
          {...props}
        />
      )}
    </TraceAggregateCard>
  );
}

function TraceBreakdownList({
  scope,
  dimension,
  onDimensionChange,
  onEnvironmentClick,
}: TraceBreakdownCardProps & {
  scope: TraceAggregateScope;
  dimension: Dimension;
  onDimensionChange: (dimension: Dimension) => void;
}) {
  const { data, isLoading, isPlaceholderData, error, refetch } = useMetricsTraceAggregate({
    timeRange: scope.timeRange,
    where: scope.where,
    groupBy: [dimension],
    measures: MEASURES,
    orderBy: { field: 'count', direction: 'desc' },
    limit: TRACE_BREAKDOWN_LIMIT,
  });
  const rows = data?.rows ?? [];
  const onRowClick = dimension === 'environment' ? onEnvironmentClick : undefined;

  const layout = {
    title: TITLE,
    description: DESCRIPTION,
    toolbar: (
      <MetricsCard.Toolbar>
        <MetricsCard.Tabs<Dimension> value={dimension} onValueChange={onDimensionChange}>
          <MetricsCard.Tab value="environment">Environment</MetricsCard.Tab>
          <MetricsCard.Tab value="executionSource">Execution source</MetricsCard.Tab>
        </MetricsCard.Tabs>
        <div aria-hidden className="flex shrink-0 items-center gap-3 text-column text-placeholder">
          {COLUMNS.map(label => (
            <span key={label} className="w-16 shrink-0 text-right">
              {label}
            </span>
          ))}
        </div>
      </MetricsCard.Toolbar>
    ),
  };

  if (error) {
    return (
      <ChartCard {...layout}>
        <ChartCardError error={error} onRetry={() => void refetch()} />
      </ChartCard>
    );
  }

  return (
    <ChartCard {...layout} isUpdating={isPlaceholderData}>
      <ChartArea isEmpty={!isLoading && rows.length === 0} emptyMessage="No traces in this range.">
        {isLoading ? (
          <MetricsCard.Loading />
        ) : (
          <ol className="min-h-0 flex-1 overflow-y-auto" aria-label={`${TITLE}: ${dimension}`}>
            {rows.map(row => (
              <BreakdownRow
                key={row.dimensions?.[dimension] ?? ''}
                value={row.dimensions?.[dimension] ?? undefined}
                row={row}
                onClick={onRowClick}
              />
            ))}
          </ol>
        )}
      </ChartArea>
      {data?.truncated && (
        <Txt variant="caption" tone="faint" className="pt-2">
          Showing the {TRACE_BREAKDOWN_LIMIT} with the most traces.
        </Txt>
      )}
    </ChartCard>
  );
}

function BreakdownRow({
  value,
  row,
  onClick,
}: {
  value: string | undefined;
  row: Row;
  onClick?: (scope: DrilldownScope) => void;
}) {
  const label = value ?? '(not set)';
  const cost = formatAggregateCost(row.measures['cost.sum'], row.cost);
  const content = (
    <>
      <Txt as="span" variant="body-sm" tone="ink" className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </Txt>
      <span className={cn(NUM, 'w-16 text-muted-foreground')}>{formatCount(row.measures['count'] ?? 0)}</span>
      <span className={cn(NUM, 'w-16 text-muted-foreground')}>{formatPercent(row.measures['errorRate'] ?? 0)}</span>
      <span className={cn(NUM, 'w-16 text-muted-foreground')} title={cost.tooltip}>
        {cost.text}
      </span>
    </>
  );
  return (
    <li>
      {onClick && value ? (
        <button
          type="button"
          className={cn(ROW, 'hover:bg-fill-subtle')}
          onClick={() => onClick({ environment: value })}
        >
          {content}
        </button>
      ) : (
        <div className={ROW}>{content}</div>
      )}
    </li>
  );
}
