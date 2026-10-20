import type { AggregateTracesArgs } from '@mastra/client-js';
import type { DrilldownScope } from '../drilldown';
import { useMetricsTraceAggregate } from '../hooks/use-metrics-trace-aggregate';
import type { TraceAggregateScope } from '../hooks/use-metrics-trace-aggregate';
import { EDGE_BUCKET_AXIS } from '../lib/chart-axis';
import { CHART_COLORS } from '../lib/chart-colors';
import { formatAxisCount, formatCount } from '../lib/chart-format';
import { bucketWindow, intervalHours } from '../lib/metrics-buckets';
import { bucketTraceAggregateRows, TRACE_AGGREGATE_SERIES_LIMIT } from '../lib/trace-aggregate';
import { ChartArea } from './chart-area';
import { ChartCard } from './chart-card';
import { ChartCardError } from './chart-card-error';
import { TraceAggregateCard } from './trace-aggregate-card';
import { MetricsCard } from '@/ds/components/MetricsCard';
import { MetricsLineChart, MetricsLineChartLegend } from '@/ds/components/MetricsLineChart';
import type { MetricsLineChartSeries } from '@/ds/components/MetricsLineChart';

const MEASURES: AggregateTracesArgs['measures'] = ['countDistinct.userId', 'countDistinct.sessionId'];

const SERIES: MetricsLineChartSeries[] = [
  { dataKey: 'users', label: 'Users', color: CHART_COLORS.sky, emphasis: true },
  { dataKey: 'sessions', label: 'Sessions', color: CHART_COLORS.green },
];

const TITLE = 'Users and sessions';
const DESCRIPTION = 'Distinct users and sessions with traces.';

export type DistinctUsersCardProps = {
  /** Called with the time range of the clicked bucket. */
  onTimeRangeClick?: (scope: DrilldownScope) => void;
};

/** Distinct users and sessions per bucket, with range totals from a second request. */
export function DistinctUsersCard(props: DistinctUsersCardProps) {
  return (
    <TraceAggregateCard title={TITLE} description={DESCRIPTION}>
      {scope => <DistinctUsersChart scope={scope} {...props} />}
    </TraceAggregateCard>
  );
}

function DistinctUsersChart({ scope, onTimeRangeClick }: DistinctUsersCardProps & { scope: TraceAggregateScope }) {
  const series = useMetricsTraceAggregate({
    timeRange: scope.timeRange,
    where: scope.where,
    interval: scope.interval,
    measures: MEASURES,
    limit: TRACE_AGGREGATE_SERIES_LIMIT,
  });
  // Bucket counts can't be added up: a user active in two buckets would count twice.
  const totals = useMetricsTraceAggregate({ timeRange: scope.timeRange, where: scope.where, measures: MEASURES });

  const chart = bucketTraceAggregateRows(series.data?.rows ?? [], scope.window).map(({ rows, ...labels }) => ({
    ...labels,
    users: rows[0]?.measures['countDistinct.userId'] ?? 0,
    sessions: rows[0]?.measures['countDistinct.sessionId'] ?? 0,
  }));
  const total = totals.data?.rows[0]?.measures;
  const users = total?.['countDistinct.userId'] ?? 0;
  const sessions = total?.['countDistinct.sessionId'] ?? 0;
  const step = intervalHours(scope.interval === '1d' ? '1d' : '1h');
  const error = series.error ?? totals.error;

  const layout = {
    title: TITLE,
    description: DESCRIPTION,
    toolbar: (
      <MetricsCard.Toolbar>
        <MetricsLineChartLegend series={SERIES} />
      </MetricsCard.Toolbar>
    ),
  };

  if (error) {
    return (
      <ChartCard {...layout}>
        <ChartCardError
          error={error}
          onRetry={() => {
            if (series.error) void series.refetch();
            if (totals.error) void totals.refetch();
          }}
        />
      </ChartCard>
    );
  }

  return (
    <ChartCard
      {...layout}
      summary={
        <MetricsCard.Summary
          value={`${formatCount(users)} users`}
          label={`${formatCount(sessions)} sessions`}
          isLoading={totals.isLoading}
        />
      }
      isUpdating={series.isPlaceholderData || totals.isPlaceholderData}
    >
      <ChartArea
        isEmpty={!series.isLoading && chart.every(b => b.users === 0 && b.sessions === 0)}
        emptyMessage="No users or sessions in this range."
      >
        <MetricsLineChart
          data={chart}
          series={SERIES}
          height="fill"
          xLabels="edges"
          showLegend={false}
          valueFormatter={formatCount}
          axisFormatter={formatAxisCount}
          onBucketClick={onTimeRangeClick && (row => onTimeRangeClick({ window: bucketWindow(Number(row.ts), step) }))}
          isLoading={series.isLoading}
          {...EDGE_BUCKET_AXIS}
        />
      </ChartArea>
    </ChartCard>
  );
}
