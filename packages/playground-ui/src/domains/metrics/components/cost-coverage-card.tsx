import type { AggregateTracesArgs } from '@mastra/client-js';
import type { DrilldownScope } from '../drilldown';
import { useMetricsTraceAggregate } from '../hooks/use-metrics-trace-aggregate';
import type { TraceAggregateScope } from '../hooks/use-metrics-trace-aggregate';
import { EDGE_BUCKET_AXIS } from '../lib/chart-axis';
import { CHART_COLORS } from '../lib/chart-colors';
import { formatPercent } from '../lib/chart-format';
import { bucketWindow, intervalHours } from '../lib/metrics-buckets';
import { bucketTraceAggregateRows, TRACE_AGGREGATE_SERIES_LIMIT } from '../lib/trace-aggregate';
import { ChartArea } from './chart-area';
import { ChartCard } from './chart-card';
import { ChartCardError } from './chart-card-error';
import { TraceAggregateCard } from './trace-aggregate-card';
import { MetricsCard } from '@/ds/components/MetricsCard';
import { MetricsLineChart } from '@/ds/components/MetricsLineChart';
import type { MetricsLineChartSeries } from '@/ds/components/MetricsLineChart';
import { formatAggregateCost } from '@/lib/cost';
import type { AggregateCostInfo } from '@/lib/cost';

const MEASURES: AggregateTracesArgs['measures'] = ['cost.sum'];

const SERIES: MetricsLineChartSeries[] = [
  { dataKey: 'coverage', label: 'Priced', color: CHART_COLORS.green, emphasis: true },
];

const TITLE = 'Cost coverage';
const DESCRIPTION = 'Share of traces with token usage that have a price.';

export type CostCoverageCardProps = {
  /** Called with the time range of the clicked bucket. */
  onTimeRangeClick?: (scope: DrilldownScope) => void;
};

/** Trace cost for the range, and how much of the usage behind it could be priced over time. */
export function CostCoverageCard(props: CostCoverageCardProps) {
  return (
    <TraceAggregateCard title={TITLE} description={DESCRIPTION}>
      {scope => <CostCoverageChart scope={scope} {...props} />}
    </TraceAggregateCard>
  );
}

function CostCoverageChart({ scope, onTimeRangeClick }: CostCoverageCardProps & { scope: TraceAggregateScope }) {
  const total = useMetricsTraceAggregate({ timeRange: scope.timeRange, where: scope.where, measures: MEASURES });
  const series = useMetricsTraceAggregate({
    timeRange: scope.timeRange,
    where: scope.where,
    interval: scope.interval,
    measures: MEASURES,
    limit: TRACE_AGGREGATE_SERIES_LIMIT,
  });

  const chart = bucketTraceAggregateRows(series.data?.rows ?? [], scope.window).map(({ rows, ...labels }) => ({
    ...labels,
    // No usage in the bucket leaves a gap rather than a drop to 0%.
    coverage: rows[0]?.cost?.coverage ?? undefined,
  }));
  const row = total.data?.rows[0];
  const headline = summarize(row?.measures['cost.sum'], row?.cost);
  const step = intervalHours(scope.interval === '1d' ? '1d' : '1h');
  const error = total.error ?? series.error;

  const layout = { title: TITLE, description: DESCRIPTION };

  if (error) {
    return (
      <ChartCard {...layout}>
        <ChartCardError
          error={error}
          onRetry={() => {
            if (total.error) void total.refetch();
            if (series.error) void series.refetch();
          }}
        />
      </ChartCard>
    );
  }

  return (
    <ChartCard
      {...layout}
      summary={<MetricsCard.Summary value={headline.value} label={headline.label} isLoading={total.isLoading} />}
      isUpdating={total.isPlaceholderData || series.isPlaceholderData}
    >
      <ChartArea
        isEmpty={!series.isLoading && chart.every(b => b.coverage === undefined)}
        emptyMessage="No traces with token usage in this range."
      >
        <MetricsLineChart
          data={chart}
          series={SERIES}
          height="fill"
          xLabels="edges"
          showLegend={false}
          yDomain={[0, 1]}
          valueFormatter={formatPercent}
          axisFormatter={formatPercent}
          onBucketClick={onTimeRangeClick && (r => onTimeRangeClick({ window: bucketWindow(Number(r.ts), step) }))}
          isLoading={series.isLoading}
          {...EDGE_BUCKET_AXIS}
        />
      </ChartArea>
    </ChartCard>
  );
}

function summarize(
  value: number | null | undefined,
  cost: AggregateCostInfo | undefined,
): { value: string; label: string } {
  if (cost?.unit === 'mixed') return { value: '—', label: 'More than one currency' };
  if (cost?.coverage == null) return { value: '—', label: 'No token usage' };
  return { value: formatAggregateCost(value, cost).text, label: `priced for ${formatPercent(cost.coverage)}` };
}
