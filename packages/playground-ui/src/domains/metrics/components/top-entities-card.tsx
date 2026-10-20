import type { AggregateTracesArgs, AggregateTracesResponse } from '@mastra/client-js';
import { EntityType } from '@mastra/core/observability';
import { useState } from 'react';
import type { DrilldownScope } from '../drilldown';
import { useMetricsTraceAggregate } from '../hooks/use-metrics-trace-aggregate';
import type { TraceAggregateScope } from '../hooks/use-metrics-trace-aggregate';
import { formatCount, formatDuration, formatPercent } from '../lib/chart-format';
import { ChartArea } from './chart-area';
import { ChartCard } from './chart-card';
import { ChartCardError } from './chart-card-error';
import { TraceAggregateCard } from './trace-aggregate-card';
import { MetricsCard } from '@/ds/components/MetricsCard';
import { NUM, ROW } from '@/ds/components/MetricsShareList/metrics-share-list-classes';
import { Txt } from '@/ds/components/Txt';
import { formatAggregateCost } from '@/lib/cost';
import { cn } from '@/lib/utils';

type View = 'slowest' | 'failing' | 'expensive';
type Row = AggregateTracesResponse['rows'][number];

/** Entities ranked client-side; the request takes the busiest ones, so every tab ranks the same set. */
export const TOP_ENTITIES_REQUEST_LIMIT = 500;
export const TOP_ENTITIES_SHOWN = 20;

const MEASURES: AggregateTracesArgs['measures'] = ['count', 'errorRate', 'errorCount', 'duration.p95', 'cost.sum'];

const ENTITY_TYPES: readonly string[] = Object.values(EntityType);
const isEntityType = (value: string | null | undefined): value is EntityType =>
  value != null && ENTITY_TYPES.includes(value);

type Column = { label: string; cell: (row: Row) => { text: string; tooltip?: string } };

const TRACES: Column = { label: 'Traces', cell: row => ({ text: formatCount(row.measures['count'] ?? 0) }) };
const num = (value: number | null | undefined) => value ?? -Infinity;

const VIEWS: Record<View, { rank: (rows: Row[]) => Row[]; columns: Column[]; empty: string }> = {
  slowest: {
    rank: rows =>
      rows
        .filter(row => row.measures['duration.p95'] != null)
        .sort((a, b) => num(b.measures['duration.p95']) - num(a.measures['duration.p95'])),
    columns: [TRACES, { label: 'P95', cell: row => ({ text: formatDuration(row.measures['duration.p95'] ?? 0) }) }],
    empty: 'No traces in this range.',
  },
  failing: {
    rank: rows =>
      rows
        .filter(row => (row.measures['errorCount'] ?? 0) > 0)
        .sort(
          (a, b) =>
            num(b.measures['errorRate']) - num(a.measures['errorRate']) ||
            num(b.measures['errorCount']) - num(a.measures['errorCount']),
        ),
    columns: [
      TRACES,
      { label: 'Errors', cell: row => ({ text: formatCount(row.measures['errorCount'] ?? 0) }) },
      { label: 'Error rate', cell: row => ({ text: formatPercent(row.measures['errorRate'] ?? 0) }) },
    ],
    empty: 'No failed traces in this range.',
  },
  expensive: {
    // A total in more than one currency has no single value to rank, so it goes last.
    rank: rows =>
      rows
        .filter(row => row.measures['cost.sum'] != null)
        .sort(
          (a, b) =>
            Number(a.cost?.unit === 'mixed') - Number(b.cost?.unit === 'mixed') ||
            num(b.measures['cost.sum']) - num(a.measures['cost.sum']),
        ),
    columns: [TRACES, { label: 'Cost', cell: row => formatAggregateCost(row.measures['cost.sum'], row.cost) }],
    empty: 'No priced traces in this range.',
  },
};

const TITLE = 'Top entities';
const DESCRIPTION = 'Agents and workflows whose traces were slowest, failed most or cost most.';

export type TopEntitiesCardProps = {
  /** Called with the root type and name of the clicked entity. */
  onEntityClick?: (scope: DrilldownScope) => void;
};

/** The 20 slowest, most failing or most expensive entities, from one grouped request. */
export function TopEntitiesCard(props: TopEntitiesCardProps) {
  return (
    <TraceAggregateCard title={TITLE} description={DESCRIPTION}>
      {scope => <TopEntitiesList scope={scope} {...props} />}
    </TraceAggregateCard>
  );
}

function TopEntitiesList({ scope, onEntityClick }: TopEntitiesCardProps & { scope: TraceAggregateScope }) {
  const [view, setView] = useState<View>('slowest');
  const { data, isLoading, isPlaceholderData, error, refetch } = useMetricsTraceAggregate({
    timeRange: scope.timeRange,
    where: scope.where,
    groupBy: ['entityType', 'entityName'],
    measures: MEASURES,
    orderBy: { field: 'count', direction: 'desc' },
    limit: TOP_ENTITIES_REQUEST_LIMIT,
  });
  const { rank, columns, empty } = VIEWS[view];
  const rows = rank([...(data?.rows ?? [])]).slice(0, TOP_ENTITIES_SHOWN);

  const layout = {
    title: TITLE,
    description: DESCRIPTION,
    toolbar: (
      <MetricsCard.Toolbar>
        <MetricsCard.Tabs<View> value={view} onValueChange={setView}>
          <MetricsCard.Tab value="slowest">Slowest</MetricsCard.Tab>
          <MetricsCard.Tab value="failing">Most failing</MetricsCard.Tab>
          <MetricsCard.Tab value="expensive">Most expensive</MetricsCard.Tab>
        </MetricsCard.Tabs>
        <div aria-hidden className="flex shrink-0 items-center gap-3 text-column text-placeholder">
          {columns.map(c => (
            <span key={c.label} className="w-16 shrink-0 text-right">
              {c.label}
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
      <ChartArea isEmpty={!isLoading && rows.length === 0} emptyMessage={empty}>
        {isLoading ? (
          <MetricsCard.Loading />
        ) : (
          <ol className="min-h-0 flex-1 overflow-y-auto" aria-label={`${TITLE}: ${view}`}>
            {rows.map(row => (
              <EntityRow
                key={`${row.dimensions?.entityType}:${row.dimensions?.entityName}`}
                row={row}
                columns={columns}
                onEntityClick={onEntityClick}
              />
            ))}
          </ol>
        )}
      </ChartArea>
      {data?.truncated && (
        <Txt variant="caption" tone="faint" className="pt-2">
          Ranked from the {TOP_ENTITIES_REQUEST_LIMIT} entities with the most traces.
        </Txt>
      )}
    </ChartCard>
  );
}

function EntityRow({
  row,
  columns,
  onEntityClick,
}: {
  row: Row;
  columns: Column[];
  onEntityClick?: (scope: DrilldownScope) => void;
}) {
  const entityType = row.dimensions?.entityType;
  const entityName = row.dimensions?.entityName ?? undefined;
  const label = entityName ?? '(not set)';
  const cells = columns.map(c => (
    <span key={c.label} className={cn(NUM, 'w-16 text-muted-foreground')} title={c.cell(row).tooltip}>
      {c.cell(row).text}
    </span>
  ));
  const content = (
    <>
      <span className="min-w-0 flex-1 truncate" title={label}>
        <Txt as="span" variant="body-sm" tone="ink">
          {label}
        </Txt>
        {entityType && (
          <Txt as="span" variant="body-sm" tone="faint" className="ml-2">
            {entityType}
          </Txt>
        )}
      </span>
      {cells}
    </>
  );
  const scope: DrilldownScope = { rootEntityType: isEntityType(entityType) ? entityType : undefined, entityName };
  return (
    <li>
      {onEntityClick && entityName ? (
        <button type="button" className={cn(ROW, 'hover:bg-fill-subtle')} onClick={() => onEntityClick(scope)}>
          {content}
        </button>
      ) : (
        <div className={ROW}>{content}</div>
      )}
    </li>
  );
}
