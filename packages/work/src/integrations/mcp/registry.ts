// GENERATED FILE - do not edit by hand.
// Source: docs/architecture/platform/contracts/mcp-registry.json
// Regenerate: pnpm mcp:contracts:generate
export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MCP_REGISTRY_VERSION = "1";

export interface McpToolDef {
  name: string;
  version: string;
  description: string;
  requiredScopes: readonly string[];
  mutating: boolean;
  destructive: boolean;
  inputSchema: Record<string, unknown>;
}

export interface McpResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  requiredScopes: readonly string[];
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeTree(child);
  }
  return value;
}

export const MCP_TOOLS: readonly McpToolDef[] = freezeTree([
  {
    "name": "pm.tasks.list",
    "version": "1",
    "description": "List tasks visible to the caller. Pagination uses cursor and limit.",
    "requiredScopes": [
      "records:read",
      "records:write",
      "views:read"
    ],
    "mutating": false,
    "destructive": false,
    "inputSchema": {
      "type": "object",
      "properties": {
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 200
        },
        "cursor": {
          "type": "string",
          "maxLength": 4096
        },
        "brand": {
          "type": "string",
          "maxLength": 64,
          "description": "Optional brand public id filter"
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "pm.tasks.get",
    "version": "1",
    "description": "Fetch one task by public id when readable.",
    "requiredScopes": [
      "records:read",
      "records:write",
      "views:read"
    ],
    "mutating": false,
    "destructive": false,
    "inputSchema": {
      "type": "object",
      "required": [
        "task_id"
      ],
      "properties": {
        "task_id": {
          "type": "string",
          "maxLength": 64
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "pm.tasks.create",
    "version": "1",
    "description": "Create a task in a brand the caller may write.",
    "requiredScopes": [
      "records:write"
    ],
    "mutating": true,
    "destructive": false,
    "inputSchema": {
      "type": "object",
      "required": [
        "title",
        "brand"
      ],
      "properties": {
        "title": {
          "type": "string",
          "maxLength": 500
        },
        "brand": {
          "type": "string",
          "maxLength": 64
        },
        "project": {
          "type": "string",
          "maxLength": 64
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "pm.tasks.complete",
    "version": "1",
    "description": "Mark a task complete. Requires confirm=true.",
    "requiredScopes": [
      "records:write"
    ],
    "mutating": true,
    "destructive": true,
    "inputSchema": {
      "type": "object",
      "required": [
        "task_id",
        "confirm"
      ],
      "properties": {
        "task_id": {
          "type": "string",
          "maxLength": 64
        },
        "confirm": {
          "type": "boolean"
        }
      },
      "additionalProperties": false
    }
  }
]);
export const MCP_RESOURCES: readonly McpResourceDef[] = freezeTree([
  {
    "uri": "pm://workspace/mcp/help",
    "name": "MCP setup guide",
    "description": "How to connect an external assistant using OAuth and MCP tools.",
    "mimeType": "text/markdown",
    "requiredScopes": [
      "records:read",
      "records:write",
      "views:read"
    ]
  },
  {
    "uri": "pm://workspace/mcp/capabilities",
    "name": "MCP capabilities",
    "description": "Server protocol version and registered tool/resource versions.",
    "mimeType": "application/json",
    "requiredScopes": [
      "records:read",
      "records:write",
      "views:read"
    ]
  }
]);

export function toolByName(name: string, version?: string): McpToolDef | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name && (!version || tool.version === version));
}

export function resourceByUri(uri: string): McpResourceDef | undefined {
  return MCP_RESOURCES.find((resource) => resource.uri === uri);
}

export function scopesAllowTool(held: readonly string[], tool: McpToolDef): boolean {
  return tool.requiredScopes.some((scope) => held.includes(scope));
}

export function scopesAllowResource(held: readonly string[], resource: McpResourceDef): boolean {
  return resource.requiredScopes.some((scope) => held.includes(scope));
}
