// GENERATED FILE - do not edit by hand.
// Source: docs/architecture/platform/contracts/agent-tools.json
// Regenerate: pnpm mcp:contracts:generate
export const AGENT_PROTOCOL = 'pm-agent/1';
export const AGENT_TOOL_REGISTRY_VERSION = 1;

export type AgentToolClass =
  | 'read_records'
  | 'draft_content'
  | 'create_subtasks'
  | 'attach_artifacts'
  | 'update_records'
  | 'run_tests'
  | 'code_change'
  | 'external_message'
  | 'publish'
  | 'spend'
  | 'access_change'
  | 'destructive'
  | 'production_change'
  | 'scope_expansion';

export interface AgentToolDef {
  name: string;
  version: string;
  tool_class: AgentToolClass;
  status: 'available' | 'unavailable';
  owner?: string;
  operation: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function freezeAll<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeAll(child);
  }
  return value;
}

export const AGENT_TOOLS: readonly AgentToolDef[] = freezeAll([
  {
    name: 'pm.tasks.list',
    version: '1',
    tool_class: 'read_records',
    status: 'available',
    operation: 'mcp:pm.tasks.list',
    description: 'List tasks inside the run scope.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
        },
        cursor: {
          type: 'string',
          maxLength: 4096,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'pm.tasks.get',
    version: '1',
    tool_class: 'read_records',
    status: 'available',
    operation: 'mcp:pm.tasks.get',
    description: 'Read one task inside the run scope.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          maxLength: 64,
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'pm.documents.get',
    version: '1',
    tool_class: 'read_records',
    status: 'available',
    operation: 'documents.read',
    description: 'Read one document inside the run scope.',
    inputSchema: {
      type: 'object',
      properties: {
        document: {
          type: 'string',
          maxLength: 64,
        },
      },
      required: ['document'],
      additionalProperties: false,
    },
  },
  {
    name: 'pm.documents.draft',
    version: '1',
    tool_class: 'draft_content',
    status: 'available',
    operation: 'documents.create_draft',
    description: 'Create a document in the draft state inside the run scope.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          maxLength: 200,
        },
        body: {
          type: 'string',
          maxLength: 100000,
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'pm.tasks.create_subtask',
    version: '1',
    tool_class: 'create_subtasks',
    status: 'available',
    operation: 'tasks.create_subtask',
    description: "Create a subtask under the run's own task.",
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          maxLength: 200,
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'pm.deliverables.draft_version',
    version: '1',
    tool_class: 'attach_artifacts',
    status: 'available',
    operation: 'deliverables.draft_version',
    description:
      "Attach an artifact as a draft deliverable version of the run's task (a human accepts it).",
    inputSchema: {
      type: 'object',
      properties: {
        deliverable: {
          type: 'string',
          maxLength: 64,
        },
        file: {
          type: 'string',
          maxLength: 64,
        },
      },
      required: ['file'],
      additionalProperties: false,
    },
  },
  {
    name: 'pm.tasks.update',
    version: '1',
    tool_class: 'update_records',
    status: 'available',
    operation: 'tasks.update',
    description:
      'Update fields of a task inside the run scope (never its completion or acceptance).',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          maxLength: 64,
        },
        priority: {
          type: 'string',
          maxLength: 16,
        },
        due_date: {
          type: 'string',
          maxLength: 10,
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'pm.tests.run',
    version: '1',
    tool_class: 'run_tests',
    status: 'unavailable',
    owner: '9B',
    operation: 'tests.run',
    description:
      'Trigger a test run in a non-production environment (test management arrives in 9B).',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'github.pull_requests.open',
    version: '1',
    tool_class: 'code_change',
    status: 'unavailable',
    owner: '9A',
    operation: 'github.pull_requests.open',
    description:
      'Open a pull request in a mapped repository (the GitHub integration arrives in 9A).',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
]);

/** A registered tool at an exact version (never a model- or connector-supplied name). */
export function agentTool(name: unknown, version: unknown): AgentToolDef | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name && tool.version === version);
}
