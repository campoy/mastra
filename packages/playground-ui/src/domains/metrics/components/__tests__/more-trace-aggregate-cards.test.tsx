// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyFilterToken } from '../../../../ds/components/PropertyFilter/types';
import { buildTracesDrilldownUrl } from '../../drilldown';
import type { DrilldownScope } from '../../drilldown';
import { MetricsProvider } from '../../hooks/use-metrics';
import { CostCoverageCard } from '../cost-coverage-card';
import { DistinctUsersCard } from '../distinct-users-card';
import { TraceBreakdownCard } from '../trace-breakdown-card';
import {
  costCoverageSeriesFixture,
  costTotalFixture,
  distinctUsersSeriesFixture,
  distinctUsersTotalsFixture,
  emptyTraceAggregateFixture,
  environmentBreakdownFixture,
  executionSourceBreakdownFixture,
  mixedCurrencyCostFixture,
  olderServerCapabilities,
  traceAggregateCapabilities,
  traceAggregateErrorFixture,
} from './fixtures/trace-aggregate';
import { seedMetrics, serveCapabilities, serveTraceAggregate } from './metrics-msw';
import type { TraceAggregateRequest } from './metrics-msw';
import { renderWithProviders } from '@/test/render';

const ERROR = "Couldn't load this data. Try again in a moment.";

let requests: TraceAggregateRequest[] = [];
const onDrilldown = vi.fn<(scope: DrilldownScope) => void>();

type Served = { empty?: boolean; cost?: typeof costTotalFixture };

function respond(request: TraceAggregateRequest, { empty = false, cost = costTotalFixture }: Served = {}) {
  if (empty) return emptyTraceAggregateFixture;
  if (request.groupBy.includes('environment')) return environmentBreakdownFixture;
  if (request.groupBy.includes('executionSource')) return executionSourceBreakdownFixture;
  if (request.measures.includes('countDistinct.userId')) {
    return request.interval ? distinctUsersSeriesFixture(request.timeRange) : distinctUsersTotalsFixture;
  }
  return request.interval ? costCoverageSeriesFixture(request.timeRange) : cost;
}

function serveCards(served?: Served) {
  serveTraceAggregate(request => {
    requests.push(request);
    return respond(request, served);
  });
}

/** Fails `failures` times (the client retries a 500 three times on its own), then serves the cards. */
function failThenServe(failures: number) {
  let calls = 0;
  serveTraceAggregate(request => {
    calls++;
    if (calls <= failures) return HttpResponse.json(traceAggregateErrorFixture, { status: 500 });
    return respond(request);
  });
}

function render(ui: ReactElement, filterTokens: PropertyFilterToken[] = []) {
  return renderWithProviders(
    <MetricsProvider preset="24h" filterTokens={filterTokens} onPresetChange={() => {}} onFilterTokensChange={() => {}}>
      {ui}
    </MetricsProvider>,
  );
}

const drilldownUrl = (scope: DrilldownScope) =>
  new URL(buildTracesDrilldownUrl({ preset: '24h', dashboardFilter: {}, scope }), 'http://studio');
const rowTexts = () =>
  within(screen.getByRole('list'))
    .getAllByRole('listitem')
    .map(item => item.textContent);

beforeEach(() => {
  requests = [];
  onDrilldown.mockReset();
  seedMetrics();
});

describe('when the server answers aggregateTraces()', () => {
  beforeEach(() => serveCapabilities(traceAggregateCapabilities));

  describe('Trace breakdown card', () => {
    it('lists traces, error rate and cost per environment, then per execution source', async () => {
      serveCards();
      render(<TraceBreakdownCard onEnvironmentClick={onDrilldown} />);

      await screen.findByText('production');
      expect(rowTexts()).toEqual(['production4005.00%$12.50', 'staging6020.0%~$0.75', '(not set)50%—']);

      fireEvent.click(screen.getByRole('tab', { name: 'Execution source' }));
      await screen.findByText('cloud');
      expect(rowTexts()).toEqual(['cloud3001.00%$8.00', 'local16510.0%$5.00']);
    });

    it('asks only for the open tab, grouped by that dimension', async () => {
      serveCards();
      render(<TraceBreakdownCard />);
      await screen.findByText('production');

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        groupBy: ['environment'],
        measures: ['count', 'errorRate', 'cost.sum'],
        orderBy: { field: 'count', direction: 'desc' },
      });
      expect(requests[0]?.interval).toBeUndefined();
    });

    it("opens a clicked environment's traces; execution sources have no Traces filter", async () => {
      serveCards();
      render(<TraceBreakdownCard onEnvironmentClick={onDrilldown} />);

      fireEvent.click(await screen.findByRole('button', { name: /staging/ }));
      const [[scope]] = onDrilldown.mock.calls;
      expect(drilldownUrl(scope).searchParams.get('filterEnvironment')).toBe('staging');
      // A row with no environment has nothing to filter on.
      expect(screen.queryByRole('button', { name: /not set/ })).toBeNull();

      fireEvent.click(screen.getByRole('tab', { name: 'Execution source' }));
      await screen.findByText('cloud');
      expect(within(screen.getByRole('list')).queryAllByRole('button')).toHaveLength(0);
    });

    it('says when the range has no traces', async () => {
      serveCards({ empty: true });
      render(<TraceBreakdownCard />);

      expect(await screen.findByText('No traces in this range.')).toBeDefined();
    });

    it('loads after Retry when the aggregate failed', async () => {
      failThenServe(4);
      render(<TraceBreakdownCard />);

      await waitFor(() => expect(screen.getByText(ERROR)).toBeDefined(), { timeout: 5000 });
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(await screen.findByText('production')).toBeDefined();
    });
  });

  describe('Users and sessions card', () => {
    it('shows range totals from their own request, not the sum of buckets', async () => {
      serveCards();
      render(<DistinctUsersCard />);

      // Buckets hold 3 + 4 users; the range has 5.
      expect(await screen.findByText('5 users')).toBeDefined();
      expect(screen.getByText('14 sessions')).toBeDefined();
    });

    it('asks for distinct users and sessions once per hour and once for the range', async () => {
      serveCards();
      render(<DistinctUsersCard />);
      await screen.findByText('5 users');

      const measures = ['countDistinct.userId', 'countDistinct.sessionId'];
      expect(requests).toHaveLength(2);
      expect(requests.find(r => r.interval)).toMatchObject({ interval: '1h', measures, groupBy: [], limit: 10 });
      expect(requests.find(r => !r.interval)).toMatchObject({ measures, groupBy: [] });
    });

    it('says when the range has no users or sessions', async () => {
      serveCards({ empty: true });
      render(<DistinctUsersCard />);

      expect(await screen.findByText('No users or sessions in this range.')).toBeDefined();
    });

    it('loads after Retry when both requests failed', async () => {
      failThenServe(8);
      render(<DistinctUsersCard />);

      await waitFor(() => expect(screen.getByText(ERROR)).toBeDefined(), { timeout: 5000 });
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(await screen.findByText('5 users')).toBeDefined();
    });
  });

  describe('Cost coverage card', () => {
    it('marks a partly priced total as approximate, with how much was priced', async () => {
      serveCards();
      render(<CostCoverageCard />);

      expect(await screen.findByText('~$42.50')).toBeDefined();
      expect(screen.getByText('priced for 80.0%')).toBeDefined();
    });

    it('shows no total when the traces were priced in more than one currency', async () => {
      serveCards({ cost: mixedCurrencyCostFixture });
      render(<CostCoverageCard />);

      expect(await screen.findByText('More than one currency')).toBeDefined();
      expect(screen.queryByText(/\$42/)).toBeNull();
    });

    it('asks for cost once for the range and once per hour', async () => {
      serveCards();
      render(<CostCoverageCard />);
      await screen.findByText('~$42.50');

      expect(requests).toHaveLength(2);
      expect(requests.find(r => r.interval)).toMatchObject({ interval: '1h', measures: ['cost.sum'], limit: 10 });
      expect(requests.find(r => !r.interval)).toMatchObject({ measures: ['cost.sum'], groupBy: [] });
    });

    it('says when no traces in the range had token usage', async () => {
      serveCards({ empty: true });
      render(<CostCoverageCard />);

      expect(await screen.findByText('No traces with token usage in this range.')).toBeDefined();
      expect(screen.getByText('No token usage')).toBeDefined();
    });

    it('loads after Retry when both requests failed', async () => {
      failThenServe(8);
      render(<CostCoverageCard />);

      await waitFor(() => expect(screen.getByText(ERROR)).toBeDefined(), { timeout: 5000 });
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(await screen.findByText('~$42.50')).toBeDefined();
    });
  });

  it('says a service filter has no trace equivalent on each card, and sends nothing', async () => {
    serveCards();
    render(
      <>
        <TraceBreakdownCard />
        <DistinctUsersCard />
        <CostCoverageCard />
      </>,
      [{ fieldId: 'serviceName', value: 'checkout' }],
    );

    await waitFor(() => expect(screen.getAllByText('Not available with a service filter.')).toHaveLength(3));
    expect(requests).toHaveLength(0);
  });
});

describe.each([
  ['the server is older than aggregateTraces()', olderServerCapabilities] as const,
  ['the capabilities request fails', 'missing'] as const,
])('when %s', (_, capabilities) => {
  it('hides the cards and sends no aggregate request', async () => {
    serveCapabilities(capabilities);
    serveCards();
    const { container } = render(
      <>
        <TraceBreakdownCard />
        <DistinctUsersCard />
        <CostCoverageCard />
      </>,
    );

    await waitFor(() => expect(container.textContent).toBe(''));
    expect(requests).toHaveLength(0);
  });
});
