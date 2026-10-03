import { GenieClient } from '../src/index.js';

/** Read an existing job: safe after a timeout; never creates or retries work. */
export async function readDocument(client: GenieClient, taskId: string): Promise<string | null> {
  const task = await client.getTask(taskId);
  if (task.status === 'FAILED' || task.status === 'CANCELLED') {
    throw new Error(`Task ended: ${task.status}`);
  }
  if (task.status !== 'COMPLETED') return null;
  if (!task.result_artifact_id) throw new Error('Completed task has no document');
  const text = await (await client.artifactContent(task.result_artifact_id)).text();
  if (!text.trim()) throw new Error('Document is empty');
  return text;
}
