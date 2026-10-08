import type { SolidDatabase } from '@undefineds.co/drizzle-solid';
import { runResource, taskResource } from '@undefineds.co/models';
import { createTasksClient, type TasksClient } from '@undefineds.co/tasks';

/** Bind the HTTP client's relative resource identifiers to this host's verified Pod. */
export function createXpodTasksClient(options: {
  fetch: typeof fetch; baseUrl: string; database?: SolidDatabase;
}): TasksClient {
  const client = createTasksClient(options);
  const database = () => {
    if (!options.database) throw new Error('请先登录并打开 Pod。');
    return options.database;
  };
  const resourceId = (resource: typeof runResource | typeof taskResource, target: string) => {
    const db = database();
    const iri = db.resolveResourceIri(resource, target);
    const id = db.resolveResourceId(resource, target);
    if (db.resolveResourceIri(resource, id) !== iri) throw new Error('该资源不属于当前 Pod。');
    return id;
  };
  return {
    ...client,
    list: async () => {
      const db = database();
      const result = await client.list();
      return { ...result, tasks: result.tasks.map(task => ({ ...task,
        iri: db.resolveResourceIri(taskResource, task.id),
      })) };
    },
    update: async (id, changes) => client.update(resourceId(taskResource, id), changes),
    pause: async (id, paused) => client.pause(resourceId(taskResource, id), paused),
    run: async id => client.run(resourceId(taskResource, id)),
    runs: async id => client.runs(resourceId(taskResource, id)),
    selection: async id => client.selection(resourceId(runResource, id)),
    steps: async id => client.steps(resourceId(runResource, id)),
    stop: async id => client.stop(resourceId(runResource, id)),
    resumeRun: async (id, approval) => client.resumeRun(resourceId(runResource, id), approval),
  };
}
