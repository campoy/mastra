---
'@mastra/playground-ui': minor
---

Added three cards to the Metrics page that read from trace aggregation:

- **Trace breakdown** lists trace count, error rate and cost per environment or execution source. Click an environment to open its traces.
- **Users and sessions** charts distinct users and sessions over time, with totals for the whole range.
- **Cost coverage** shows trace cost for the range and how much of the token usage behind it had a price. A partly priced total shows as approximate (`~$42.50`), and a total in more than one currency isn't shown.

The cards are hidden on servers that don't support trace aggregation.
