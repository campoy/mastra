---
'@mastra/temporal': patch
---

Fixed Temporal workflow runs returning the workflow output inside an extra result object. Read the output directly from `runResult.result`, as with a local Mastra run.
