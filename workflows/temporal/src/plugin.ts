import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WorkerOptions, WorkerPlugin } from '@temporalio/worker';
import type { TemporalActivityBinding } from './transforms/activities';
import { buildTemporalActivitiesModule } from './transforms/activities';
import { buildTemporalWorkflowModule } from './transforms/workflows';

const CACHE_PATH = 'node_modules/.mastra';
const WORKFLOW_FILE_NAME = 'workflow.mjs';
const ACTIVITIES_FILE_NAME = 'activities.mjs';
const ACTIVITY_BINDINGS_FILE_NAME = 'activity-bindings.json';
// A Worker takes one workflowsPath. To let several MastraPlugins share a Worker, remember for each
// generated (or combined) Workflow module the Workflow types it exports and the generated modules it
// contains, and which compiled step each generated Activity runs. Apps installed separately load
// their own copy of this package, so the registry lives on globalThis, where every copy finds it.
const { workflowModules, activitySources } = ((globalThis as Record<symbol, unknown>)[
  Symbol.for('@mastra/temporal/worker-registry/v1')
] ??= {
  workflowModules: new Map<string, { exports: Set<string>; sources: Set<string> }>(),
  activitySources: new WeakMap<object, string>(),
}) as {
  workflowModules: Map<string, { exports: Set<string>; sources: Set<string> }>;
  activitySources: WeakMap<object, string>;
};

/** Writes export names for `export { … } from`: identifiers as they are, other names as strings. */
function exportList(names: Set<string>): string {
  return [...names]
    .map(name => (/^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u.test(name) ? name : JSON.stringify(name)))
    .join(', ');
}

/**
 * Returns the workflowsPath for this plugin's module plus one an earlier MastraPlugin set: a module
 * that re-exports both. Two entries that export the same Workflow type would run each other's
 * workflows, so that fails. A workflowsPath from anywhere else is replaced, as before.
 */
async function combineWorkflowModules(earlier: string | undefined, own: string, outputDir: string): Promise<string> {
  const earlierModule = earlier ? workflowModules.get(earlier) : undefined;
  const ownModule = workflowModules.get(own);
  if (!earlier || !earlierModule || !ownModule) {
    return own;
  }
  // The same plugin, or one built from the same entry and project root, is already included.
  if ([...ownModule.sources].every(source => earlierModule.sources.has(source))) {
    return earlier;
  }

  const duplicate = [...ownModule.exports].find(name => earlierModule.exports.has(name));
  if (duplicate) {
    throw new TypeError(
      `Duplicate registration of Workflow type '${duplicate}': two MastraPlugin entries on this Worker export it. ` +
        'Give the workflows different ids, or put each Mastra app on its own Worker and Task Queue.',
    );
  }

  const source =
    `export { ${exportList(earlierModule.exports)} } from ${JSON.stringify(earlier)};\n` +
    `export { ${exportList(ownModule.exports)} } from ${JSON.stringify(own)};\n`;
  // One file per combination, so Workers that combine different plugins do not overwrite each
  // other's module. Write and rename, so a Worker never reads a half-written file.
  const combinedPath = path.join(
    outputDir,
    `combined-workflow-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.mjs`,
  );
  const tempPath = `${combinedPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, source, 'utf8');
  await rename(tempPath, combinedPath);
  workflowModules.set(combinedPath, {
    exports: new Set([...earlierModule.exports, ...ownModule.exports]),
    sources: new Set([...earlierModule.sources, ...ownModule.sources]),
  });
  return combinedPath;
}

/** Fails when an earlier MastraPlugin registered a different step under one of these Activity names. */
function checkActivityNames(existing: object | undefined, generated: Record<string, unknown>): void {
  for (const [name, activity] of Object.entries(generated)) {
    const current = (existing as Record<string, unknown> | undefined)?.[name];
    const currentSource = typeof current === 'function' ? activitySources.get(current) : undefined;
    if (currentSource && currentSource !== activitySources.get(activity as object)) {
      throw new TypeError(
        `Duplicate registration of Activity '${name}': two MastraPlugin entries on this Worker have a step with this id. ` +
          'Rename one, or put each Mastra app on its own Worker and Task Queue.',
      );
    }
  }
}

function getGeneratedWorkflowModulePath(outputDir: string): string {
  return path.join(outputDir, WORKFLOW_FILE_NAME);
}

function getGeneratedActivitiesModulePath(outputDir: string): string {
  return path.join(outputDir, ACTIVITIES_FILE_NAME);
}

function getActivityBindingsPath(outputDir: string): string {
  return path.join(outputDir, ACTIVITY_BINDINGS_FILE_NAME);
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

    const { exports } = await buildTemporalWorkflowModule(compiledEntryPath, temporalOutputDir, WORKFLOW_FILE_NAME);
    const workflowModulePath = getGeneratedWorkflowModulePath(temporalOutputDir);
    workflowModules.set(workflowModulePath, { exports: new Set(exports), sources: new Set([workflowModulePath]) });

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

      const generatedActivity = async (...args: unknown[]) => {
        const activityModule = await this.#loadCompiledActivitiesModule(compiledActivitiesPath);
        const activity = activityModule[binding.exportName];

        if (typeof activity !== 'function') {
          throw new Error(`Unable to load activity '${binding.exportName}' from ${compiledActivitiesPath}`);
        }

        return activity(...args);
      };
      activitySources.set(generatedActivity, `${compiledActivitiesPath}#${binding.exportName}`);
      generatedActivities[binding.stepId] = generatedActivity;
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
    const workflowsPath = await combineWorkflowModules(
      options.workflowsPath,
      generatedOptions.workflowsPath!,
      this.#prebuildPath!,
    );
    checkActivityNames(options.activities, generatedOptions.activities as Record<string, unknown>);
    Object.assign(augmentedOptions, generatedOptions, {
      workflowsPath,
      activities: {
        ...options.activities,
        ...generatedOptions.activities,
      },
    });

    return augmentedOptions;
  }
}
