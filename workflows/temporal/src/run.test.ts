import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStep, createWorkflow as createLocalWorkflow } from '@mastra/core/workflows';
import type { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { toWorkflowType } from './utils';
import { createWorkflow } from './workflow';

describe('TemporalRun', () => {
  it('returns the same output and step records as a local run', async () => {
    const env = await TestWorkflowEnvironment.createLocal({
      server: {
        executable: process.env.TEMPORAL_CLI_PATH
          ? { type: 'existing-path', path: process.env.TEMPORAL_CLI_PATH }
          : undefined,
      },
    });
    const packageRoot = fileURLToPath(new URL('..', import.meta.url));
    const directory = await realpath(await mkdtemp(path.join(packageRoot, '.start-result-')));

    try {
      const workflowsPath = path.join(directory, 'workflow.mjs');
      const runtimePath = fileURLToPath(new URL('./transforms/temporal-workflow-runtime.mjs', import.meta.url));
      await writeFile(
        workflowsPath,
        `import { createWorkflow } from ${JSON.stringify(runtimePath)};
         export const echoWorkflow = createWorkflow('echo-workflow').then('echo').commit();
         export const pairWorkflow = createWorkflow('pair-workflow').then('make').then('measure').commit();`,
      );
      const taskQueue = `start-result-${crypto.randomUUID()}`;
      const schema = z.unknown();
      const stateSchema = z.object({ date: z.date(), optional: z.unknown().optional() });
      const inputSchema = stateSchema.extend({ output: schema });
      const echo = createStep({
        id: 'echo',
        inputSchema,
        outputSchema: schema,
        execute: async ({ inputData }) => inputData.output,
      });
      const config = { id: 'echo-workflow', inputSchema, outputSchema: schema, stateSchema };
      const local = createLocalWorkflow(config).then(echo).commit();
      const temporal = createWorkflow(config, { client: env.client, taskQueue }).then(echo).commit();
      // `make` returns undefined for size 0, else a string of that size; `measure` returns its length.
      const makeOutput = ({ inputData }: { inputData: { size: number } }) =>
        inputData.size ? 'x'.repeat(inputData.size) : undefined;
      const measureOutput = ({ inputData }: { inputData?: string }) => ({ length: inputData?.length ?? 0 });
      const make = createStep({
        id: 'make',
        inputSchema: z.object({ size: z.number() }),
        outputSchema: z.string().optional(),
        execute: async args => makeOutput(args),
      });
      const measure = createStep({
        id: 'measure',
        inputSchema: z.string().optional(),
        outputSchema: z.object({ length: z.number() }),
        execute: async args => measureOutput(args),
      });
      const pairConfig = {
        id: 'pair-workflow',
        inputSchema: z.object({ size: z.number() }),
        outputSchema: z.unknown(),
      };
      const localPair = createLocalWorkflow(pairConfig).then(make).then(measure).commit();
      const temporalPair = createWorkflow(pairConfig, { client: env.client, taskQueue })
        .then(make)
        .then(measure)
        .commit();
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities: {
          echo: async ({ inputData }: { inputData: { output: unknown } }) => inputData.output,
          make: async (args: { inputData: { size: number } }) => makeOutput(args),
          measure: async (args: { inputData?: string }) => measureOutput(args),
        },
      });

      await worker.runUntil(async () => {
        // Preserve null and user outputs containing their own result field. A step that returns
        // undefined still gets a record.
        for (const output of [{ value: 6 }, null, { result: { value: 6 } }, 0, false, '', undefined]) {
          const initialState = { date: new Date('2026-10-20T00:00:00Z'), optional: undefined };
          const inputData = { ...initialState, output };
          const expected = await (await local.createRun()).start({ inputData, initialState });
          const actual = await (await temporal.createRun()).start({ inputData, initialState });
          expect(expected.status).toBe('success');
          expect(actual.status).toBe('success');
          if (expected.status === 'success' && actual.status === 'success') {
            expect(actual.result).toEqual(expected.result);
            expect(actual.input).toStrictEqual(expected.input);
            expect(actual.state).toStrictEqual(initialState);
            const record = { status: 'success', output, startedAt: expect.any(Number), endedAt: expect.any(Number) };
            expect(expected.steps).toMatchObject({ input: inputData, echo: record });
            expect(actual.steps).toEqual({ input: inputData, echo: record });
          }
        }

        // A void step before another step keeps its record. A 1,300,000-character intermediate output
        // fits in the result without step records (default limit 2 MB), so the records must not copy it.
        for (const size of [0, 1_300_000]) {
          const expected = await (await localPair.createRun()).start({ inputData: { size } });
          const actual = await (await temporalPair.createRun()).start({ inputData: { size } });
          expect(expected.status).toBe('success');
          expect(actual.status).toBe('success');
          if (expected.status === 'success' && actual.status === 'success') {
            expect(actual.result).toEqual(expected.result);
            expect(Object.keys(actual.steps)).toEqual(Object.keys(expected.steps));
            for (const stepId of ['make', 'measure'] as const) {
              const native = expected.steps[stepId];
              expect(actual.steps[stepId]).toEqual({
                status: 'success',
                output: native?.status === 'success' ? native.output : 'missing',
                startedAt: expect.any(Number),
                endedAt: expect.any(Number),
              });
            }
          }
        }

        // An execution started without recordStepMeta (by an older client, before a Worker upgrade)
        // keeps its result unchanged. This one is about 20 bytes under the 2 MB limit once encoded;
        // stepMeta would add about 130 bytes and stop it from completing.
        const size = 2_096_976;
        const handle = await env.client.workflow.start(toWorkflowType('pair-workflow'), {
          taskQueue,
          workflowId: `pair-${crypto.randomUUID()}`,
          args: [{ inputData: { size }, initialState: undefined, requestContext: {} }],
        });
        const raw = await handle.result();
        expect(raw).toEqual({
          status: 'success',
          input: { size },
          result: { length: size },
          steps: { make: 'x'.repeat(size), measure: { length: size } },
        });
        expect(JSON.stringify(raw).length).toBe(2_097_098);
      });
    } finally {
      await env.teardown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not execute stream runs with the local workflow engine', async () => {
    const execute = vi.fn().mockResolvedValue({ value: 2 });
    const start = vi.fn();
    const schema = z.object({ value: z.number() });
    const step = createStep({
      id: 'increment',
      inputSchema: schema,
      outputSchema: schema,
      execute,
    });
    const workflow = createWorkflow(
      { id: 'test-workflow', inputSchema: schema, outputSchema: schema },
      { client: { workflow: { start } } as unknown as Client, taskQueue: 'test-queue' },
    )
      .then(step)
      .commit();
    const run = await workflow.createRun({ runId: 'test-run' });

    expect(() => run.stream({ inputData: { value: 1 } })).toThrow(
      '@mastra/temporal does not support stream() yet. Use start() or startAsync() instead.',
    );
    expect(start).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    'streamLegacy',
    'resumeStream',
    'resume',
    'resumeAsync',
    'restart',
    'timeTravel',
    'timeTravelStream',
  ] as const)('rejects unsupported %s calls instead of using the local workflow engine', async method => {
    const workflow = createWorkflow(
      { id: 'test-workflow', inputSchema: z.unknown(), outputSchema: z.unknown() },
      { client: { workflow: {} } as unknown as Client, taskQueue: 'test-queue' },
    );
    const run = await workflow.createRun({ runId: 'test-run' });

    expect(() => (run[method] as (...args: unknown[]) => unknown)()).toThrow(
      `@mastra/temporal does not support ${method}() yet. Use start() or startAsync() instead.`,
    );
  });

  it('cancels the matching Temporal workflow before updating local state', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const getHandle = vi.fn().mockReturnValue({ cancel });
    const workflow = createWorkflow(
      { id: 'test-workflow' },
      { client: { workflow: { getHandle } } as unknown as Client, taskQueue: 'test-queue' },
    );
    const run = await workflow.createRun({ runId: 'test-run' });

    await run.cancel();

    expect(getHandle).toHaveBeenCalledWith('test-run');
    expect(cancel).toHaveBeenCalledOnce();
    expect(run.workflowRunStatus).toBe('canceled');
    expect(run.abortController.signal.aborted).toBe(true);
  });

  it('leaves local state unchanged when Temporal cancellation fails', async () => {
    const error = new Error('Temporal service unavailable');
    const cancel = vi.fn().mockRejectedValue(error);
    const getHandle = vi.fn().mockReturnValue({ cancel });
    const workflow = createWorkflow(
      { id: 'test-workflow' },
      { client: { workflow: { getHandle } } as unknown as Client, taskQueue: 'test-queue' },
    );
    const run = await workflow.createRun({ runId: 'test-run' });

    await expect(run.cancel()).rejects.toThrow(error);

    expect(getHandle).toHaveBeenCalledWith('test-run');
    expect(run.workflowRunStatus).toBe('pending');
    expect(run.abortController.signal.aborted).toBe(false);
  });
});
