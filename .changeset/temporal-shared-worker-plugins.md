---
'@mastra/temporal': minor
---

**Breaking:** Several `MastraPlugin`s can now share one Temporal Worker, one per Mastra app. Before, the last plugin replaced the others' workflows without a warning: a run of the first app executed the second app's workflow when both had a workflow with the same id, or failed every task when the ids differed. Now the Worker gets every app's workflows. `Worker.create()` fails with a `TypeError` when two apps have a workflow with the same id, or different steps with the same id, because one app's runs would execute the other's code.

```ts
const worker = await Worker.create({
  connection,
  taskQueue: 'mastra',
  plugins: [new MastraPlugin(appAEntry, appARoot), new MastraPlugin(appBEntry, appBRoot)],
});
// Before: app A's 'greet' runs could execute app B's 'greet' workflow.
// After: Duplicate registration of Workflow type 'greetWorkflow': two MastraPlugin entries on this Worker export it.
```

If your Worker starts two plugins whose apps share a workflow or step id, rename one, or run each app on its own Worker and task queue.
