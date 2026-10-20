---
'@mastra/playground-ui': minor
---

Added two cards to the Metrics page that read from trace aggregation:

- **Trace latency** charts P50, P90 and P99 trace duration over time, with tabs for agents and workflows. Click a point to open those traces.
- **Top entities** ranks the 20 slowest, most failing and most expensive agents and workflows. Click a row to open its traces with the page filters applied.

Both cards are hidden on servers that don't support trace aggregation, and show a message instead of data when a page filter has no trace equivalent.
