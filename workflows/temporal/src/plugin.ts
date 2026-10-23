import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { toStandardSchema } from '@mastra/core/schema';
import type { PublicSchema } from '@mastra/core/schema';
import { validateStepInput } from '@mastra/core/workflows';
import { ApplicationFailure } from '@temporalio/activity';
import type { WorkerOptions, WorkerPlugin } from '@temporalio/worker';
import type { TemporalActivityBinding } from './transforms/activities';
import { buildTemporalActivitiesModule } from './transforms/activities';
import { buildTemporalWorkflowModule } from './transforms/workflows';

const CACHE_PATH = 'node_modules/.mastra';
const WORKFLOW_FILE_NAME = 'workflow.mjs';
const ACTIVITIES_FILE_NAME = 'activities.mjs';
const ACTIVITY_BINDINGS_FILE_NAME = 'activity-bindings.json';

function getGeneratedWorkflowModulePath(outputDir: string): string {
  return path.join(outputDir, WORKFLOW_FILE_NAME);
}

function getGeneratedActivitiesModulePath(outputDir: string): string {
  return path.join(outputDir, ACTIVITIES_FILE_NAME);
}

function getActivityBindingsPath(outputDir: string): string {
  return path.join(outputDir, ACTIVITY_BINDINGS_FILE_NAME);
}

type StepParams = { inputData?: unknown; validateInputs?: boolean } & Record<string, unknown>;

/**
 * Checks a step's input against its inputSchema before the step runs, as Mastra's
 * validateStepInput does, and passes the parsed value on. The Workflow sends the run's
 * validateInputs setting; runs started without it keep running steps unchecked.
 * Retrying cannot fix the input, so a mismatch fails the Activity without retries.
 */
async function checkStepInput(inputSchema: unknown, params: StepParams): Promise<StepParams> {
  const { validateInputs, ...rest } = params;
  if (validateInputs !== true || !inputSchema) {
    return rest;
  }

  const { inputData, validationError } = await validateStepInput({
    prevOutput: rest.inputData,
    step: { inputSchema: toStandardSchema(inputSchema as PublicSchema) },
    validateInputs: true,
  });
  if (validationError) {
    throw ApplicationFailure.create({
      type: 'WORKFLOW_STEP_INPUT_VALIDATION_FAILED',
      message: validationError.message,
      nonRetryable: true,
      cause: validationError,
    });
  }
  return { ...rest, inputData };
}

export class MastraPlugin implements WorkerPlugin {
  #prebuildPath: string | null = null;
  #prebuildPromise: Promise<ReturnType<typeof this.getTemporalWorkerOptions>> | null = null;
  #compiledActivitiesModules = new Map<string, Promise<Record<string, unknown>>>();
  name = 'Mastra';

  constructor(
    private readonly entryFile: string,
    private readonly projectRoot: string = process.cwd(),
  ) {}

  async #bundleMastra(entryFile: string, projectRoot: string, outputDirectory: string): Promise<string> {
    const { BuildBundler } = await import('./mastra-deployer');
    const normalizedEntryFile = entryFile.startsWith('file:/') ? fileURLToPath(entryFile) : entryFile;
    const mastraBundler = new BuildBundler();
    await mastraBundler.prepare(outputDirectory);
    await mastraBundler.bundle(normalizedEntryFile, outputDirectory, {
      toolsPaths: [],
      projectRoot,
    });

    return path.join(outputDirectory, 'output', 'index.mjs');
  }

  /**
   * @deprecated Please use the constructor params instead.
   */
  async prebuild({
    entryFile,
    projectRoot = process.cwd(),
  }: {
    entryFile: string;
    projectRoot?: string;
  }): Promise<ReturnType<typeof this.getTemporalWorkerOptions>> {
    return this.#prebuild(entryFile, projectRoot);
  }

  async #prebuild(entryFile: string, projectRoot: string): Promise<ReturnType<typeof this.getTemporalWorkerOptions>> {
    const temporalOutputDir = path.resolve(projectRoot, CACHE_PATH);
    const compiledEntryPath = await this.#bundleMastra(entryFile, projectRoot, temporalOutputDir);

    await buildTemporalWorkflowModule(compiledEntryPath, temporalOutputDir, WORKFLOW_FILE_NAME);

    const { activityBindings } = await buildTemporalActivitiesModule(
      compiledEntryPath,
      temporalOutputDir,
      ACTIVITIES_FILE_NAME,
    );

    await writeFile(getActivityBindingsPath(temporalOutputDir), JSON.stringify(activityBindings, null, 2), 'utf8');

    this.#prebuildPath = temporalOutputDir;
    return this.getTemporalWorkerOptions(temporalOutputDir);
  }

  #loadActivityBindings(activityBindingsPath: string): TemporalActivityBinding[] {
    try {
      const bindings = JSON.parse(readFileSync(activityBindingsPath, 'utf8')) as TemporalActivityBinding[];
      return bindings;
    } catch (error) {
      throw new Error(`MastraPlugin.prebuild() must be called before use, or ${activityBindingsPath} must exist`, {
        cause: error,
      });
    }
  }

  #loadCompiledActivitiesModule(activitiesModulePath: string): Promise<Record<string, unknown>> {
    const cachedModule = this.#compiledActivitiesModules.get(activitiesModulePath);
    if (cachedModule) {
      return cachedModule;
    }

    const modulePromise = import(`${pathToFileURL(activitiesModulePath).href}?t=${Date.now()}`) as Promise<
      Record<string, unknown>
    >;

    this.#compiledActivitiesModules.set(activitiesModulePath, modulePromise);
    return modulePromise;
  }

  #generateActivityBindings(
    activityBindings: TemporalActivityBinding[],
    compiledActivitiesPath: string,
  ): Record<string, (...args: unknown[]) => Promise<unknown>> {
    const generatedActivities: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const binding of activityBindings) {
      if (generatedActivities[binding.stepId]) {
        continue;
      }

      generatedActivities[binding.stepId] = async (...args: unknown[]) => {
        const activityModule = await this.#loadCompiledActivitiesModule(compiledActivitiesPath);
        const activity = activityModule[binding.exportName];

        if (typeof activity !== 'function') {
          throw new Error(`Unable to load activity '${binding.exportName}' from ${compiledActivitiesPath}`);
        }

        const [params, ...rest] = args;
        if (params && typeof params === 'object') {
          const { inputSchema } = activity as { inputSchema?: unknown };
          return activity(await checkStepInput(inputSchema, params as StepParams), ...rest);
        }
        return activity(...args);
      };
    }

    return generatedActivities;
  }

  getTemporalWorkerOptions(temporalOutputDir: string): {
    // workflowBundle: WorkerOptions['workflowBundle'];
    workflowsPath: WorkerOptions['workflowsPath'];
    activities: WorkerOptions['activities'];
  } {
    const workflowOutputPath = getGeneratedWorkflowModulePath(temporalOutputDir);
    const activitiesOutputPath = getGeneratedActivitiesModulePath(temporalOutputDir);
    const activityBindings = this.#loadActivityBindings(getActivityBindingsPath(temporalOutputDir));

    return {
      workflowsPath: workflowOutputPath,
      // workflowBundle: {
      //   codePath: workflowOutputPath,
      //   sourceMapPath: `${workflowOutputPath}.map`,
      // },
      activities: this.#generateActivityBindings(activityBindings, activitiesOutputPath),
    };
  }

  async configureWorker(options: WorkerOptions): Promise<WorkerOptions> {
    const augmentedOptions = Object.assign({}, options);
    if (!this.#prebuildPath) {
      this.#prebuildPromise ??= this.#prebuild(this.entryFile, this.projectRoot).catch(error => {
        this.#prebuildPromise = null;
        throw error;
      });
      await this.#prebuildPromise;
    }

    const generatedOptions = this.getTemporalWorkerOptions(this.#prebuildPath!);
    Object.assign(augmentedOptions, generatedOptions, {
      activities: {
        ...options.activities,
        ...generatedOptions.activities,
      },
    });

    return augmentedOptions;
  }
}
