/**
 * Host-agnostic client for the WebRobot Agent Studio.
 *
 * The studio authors an `agent_definition { crews, orchestration:{entry,edges,type} }` — the
 * DAG of agents/crews that execute on Ray — and persists it as an agent template. This client
 * carries the API calls it needs, injected rather than imported, so the studio can run outside
 * the Next app (e.g. a WordPress plugin): the host calls configureAgentStudio() once with an
 * apiBase and a token provider.
 *
 * Paths are kept as the app used them (relative BFF routes). The host decides via apiBase
 * whether those resolve to its own BFF proxy or straight to the backend.
 */
export interface AgentStudioConfig {
  /** Prefixes every request path. '' keeps the app's relative BFF routes; a full origin points elsewhere. */
  apiBase: string;
  /** Returns the current bearer token (or null). A function, so a rotated token is picked up. */
  getToken: () => string | null;
}

let _config: AgentStudioConfig | null = null;

export function configureAgentStudio(cfg: AgentStudioConfig): void {
  _config = { ...cfg, apiBase: cfg.apiBase.replace(/\/$/, '') };
}

function config(): AgentStudioConfig {
  if (!_config) {
    // Default: same-origin BFF relative paths + JWT from localStorage — the Next app's behaviour.
    _config = {
      apiBase: '',
      getToken: () =>
        typeof localStorage !== 'undefined' ? localStorage.getItem('jwt') : null,
    };
  }
  return _config;
}

export class AgentStudioError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = 'AgentStudioError';
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { apiBase, getToken } = config();
  const token = getToken();
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new AgentStudioError(res.status, (j as any)?.error || `HTTP ${res.status}`, j);
  return j as T;
}

// Generate an agent_definition from a natural-language description.
export const generateAgents = (description: string, approach: string) =>
  call<any>('POST', '/api/agents/generate', { description, approach });

// Agent template persistence (the listing that carries agent_definition).
export const createAgentTemplate = (body: unknown) =>
  call<any>('POST', '/api/admin/agent-templates', body);
export const updateAgentTemplate = (id: string, body: unknown) =>
  call<any>('PUT', `/api/admin/agent-templates/${encodeURIComponent(id)}`, body);
export const submitAgentTemplate = (id: string) =>
  call<any>('POST', `/api/admin/agent-templates/${encodeURIComponent(id)}/submit`, {});

// Agentic profiles (the persistent, runnable form of a team).
export const listAgenticProfiles = () => call<any>('GET', '/api/admin/agentic/profiles');
export const getAgenticProfile = (id: string) =>
  call<any>('GET', `/api/admin/agentic/profiles/${encodeURIComponent(id)}`);
export const saveAgenticProfile = (body: unknown, id?: string) =>
  id
    ? call<any>('PUT', `/api/admin/agentic/profiles/${encodeURIComponent(id)}`, body)
    : call<any>('POST', '/api/admin/agentic/profiles', body);
