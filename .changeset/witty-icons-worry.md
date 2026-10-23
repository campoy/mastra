---
'@mastra/temporal': minor
---

**Breaking:** `run.start()` on a Temporal workflow now returns the same result shape as a local Mastra run. Fixes #27934.

Before, `result` held the whole Temporal workflow result, so the workflow output was one level deeper, and `steps` was always empty. Now `result` is the workflow output, and `steps` has a record for each step with its `status`, `output`, `startedAt` and `endedAt`, plus the workflow `input`.

Before:

```ts
const result = await run.start({ inputData: { value: 5 } });
result.result.result.value; // 6
result.result.steps.increment.value; // 6
```

After:

```ts
const result = await run.start({ inputData: { value: 5 } });
result.result.value; // 6
result.steps.increment.output.value; // 6
```

Remove any extra `.result` your code added to read the output. Step records need Workers on this version: a run that an older Worker finishes still returns `steps: {}`.
