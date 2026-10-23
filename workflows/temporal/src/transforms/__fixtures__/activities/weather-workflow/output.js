import { RequestContext } from '@mastra/core/di';
import { z } from 'zod';

function withRequestContext(params) {
  const {
    requestContext,
    initData,
    ...rest
  } = params;
  return {
    ...rest,
    requestContext: new RequestContext(requestContext),
    getInitData: () => initData
  };
}
function createStep(args) {
  // MastraPlugin checks the input against the step's schema before it runs the step.
  return Object.assign(async params => {
    return args.execute({
      ...withRequestContext(params),
      mastra
    });
  }, {
    inputSchema: args.inputSchema
  });
}
const mastra = {
  marker: 'ok'
};
const fetchWeather = createStep({
  id: 'fetch-weather',
  inputSchema: z.object({
    city: z.string()
  }),
  outputSchema: z.object({
    city: z.string()
  }),
  execute: async ({
    inputData
  }) => inputData
});
function createPlanActivities() {
  return createStep({
    id: 'plan-activities',
    inputSchema: z.object({
      city: z.string()
    }),
    outputSchema: z.object({
      city: z.string()
    }),
    execute: async ({
      inputData
    }) => inputData
  });
}
const planActivities = createPlanActivities();

export { fetchWeather, planActivities };