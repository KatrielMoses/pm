import { sql } from '@pm/db';

/**
 * Cross-record reads over the record types that host collaboration (tasks, projects, and, from 4C,
 * documents). `r` is `core.record`; a document's governing project is its attached project, or
 * the project of the task it is attached to.
 */
export const recordJoins = sql`
  LEFT JOIN work.task t ON t.workspace_id = r.workspace_id AND t.id = r.id
  LEFT JOIN work.project w ON w.workspace_id = r.workspace_id AND w.id = r.id
  LEFT JOIN knowledge.document kd ON kd.workspace_id = r.workspace_id AND kd.id = r.id
  LEFT JOIN work.task kt ON kt.workspace_id = kd.workspace_id AND kt.id = kd.attached_task_id`;
export const recordProject = sql`COALESCE(t.project_id, w.id, kd.attached_project_id, kt.project_id)`;
export const recordTitle = sql`COALESCE(t.title, w.name, kd.title)`;
export const recordTypes = sql`('task', 'project', 'document')`;
