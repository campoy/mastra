---
'@mastra/temporal': minor
---

**Breaking:** Temporal workflow steps now check their input against `inputSchema` before they run, as local Mastra runs do. Before, a step ran on input that broke its schema, and the workflow could succeed with a wrong value. Now the step fails without retries and `run.start()` returns `status: 'failed'`. The step also gets the parsed input, with schema defaults and transforms applied. Set `options: { validateInputs: false }` on the workflow to keep the old behavior.

Runs started before the upgrade, and runs started without `createRun().start()` or `startAsync()`, keep running steps unchecked.

Check these steps before upgrading:

- A step whose `inputSchema` has `z.date()`. Step input reaches the activity through Temporal's data converter, which turns a `Date` into a string, so the check fails. Use `z.coerce.date()`:

  ```ts
  // Before
  inputSchema: z.object({ when: z.date() }),
  // After
  inputSchema: z.object({ when: z.coerce.date() }),
  ```

- A step that parses `inputData` itself with a schema that changes the value's type, such as `z.string().transform(Number)`. It now gets the parsed value, so its own parse fails. Remove the extra parse:

  ```ts
  // Before
  execute: async ({ inputData }) => ({ value: schema.parse(inputData).value + 1 }),
  // After
  execute: async ({ inputData }) => ({ value: inputData.value + 1 }),
  ```
