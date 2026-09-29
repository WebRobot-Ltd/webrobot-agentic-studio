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
  /**
   * Percorso da cui l'host dice qual e' il profilo dell'agente PROGETTISTA di profili agentici
   * (`webrobot-agent-designer`). Deve rispondere `{ id: <number> }`. Serve per il ramo "descrivi il
   * team -> l'agente lo progetta": quel profilo e' di SISTEMA (org della piattaforma) e l'elenco
   * `/agentic/profiles` e' filtrato per organizzazione, quindi un tenant non lo vede e cercarlo per
   * nome da qui non funziona. L'host lo risolve con la propria chiave di piattaforma e ne restituisce
   * il solo id. Stesso schema del pipeline studio (designerProfileUrl). Assente: il ramo e' disattivo.
   */
  agentDesignerProfileUrl?: string;
  /** Catalogo degli MCP integrati (con credenziali per-org) offerti nel form. Specifico del cluster:
   *  lo passa l'host. Assente: nessuna integrazione proposta. */
  mcpIntegrations?: McpIntegration[];
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

// Publish a saved agentic profile to the marketplace (creates a pending_approval listing).
// This is the canonical publish path used by the dashboard editor — NOT the legacy
// agent-templates submit, which writes to a divergent store the runtime no longer reads.
export const publishAgenticProfile = (body: unknown) =>
  call<any>('POST', '/api/admin/agentic/marketplace', body);

// ── Trading layer ───────────────────────────────────────────────────────────
// These live under /api/trading (NOT the /api/admin/agentic base): a strategy is
// an agent, and these routes bind it to a market and deploy it as a bot. The
// guardrails (trading enabled, cap, allow-list) are enforced server-side.

// Allow-list read from the tenant (organizations.trading_limits) so the user PICKS
// instruments instead of guessing. organizationId is optional (super_admin acting
// on behalf of a tenant; empty = the caller's own org).
export const allowedAssets = (organizationId?: string) =>
  call<any>(
    'GET',
    `/api/trading/allowed${organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : ''}`,
  );

// Register a strategy-agent in the strategy registry (kind: agentic) → strategyId.
export const registerStrategy = (body: unknown) =>
  call<any>('POST', '/api/trading/strategies', body);

// Deploy (start) the bot for a registered strategy. organizationId is optional
// (super_admin must operate on behalf of a tenant).
export const deployBot = (body: unknown, organizationId?: string) =>
  call<any>(
    'POST',
    `/api/trading/bots${organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : ''}`,
    body,
  );

// ── Design an agent profile from natural language (the "describe -> agent designs it" loop) ──
//
// Speculare al pipeline studio: si avvia il profilo di sistema `webrobot-agent-designer`, se ne fa
// polling e se ne legge il RESULT (che e' l'agent_definition JSON), mostrato poi come proposta con
// diff nel form. Gli endpoint sono gli stessi della piattaforma, proxati same-origin dall'host
// (/api/agentic/start | /{eid} | /executions).

export interface AgentRun { executionId: string }

let _agentDesignerProfileId: number | null = null;

export async function findAgentDesignerProfileId(): Promise<number> {
  if (_agentDesignerProfileId) return _agentDesignerProfileId;
  const url = config().agentDesignerProfileUrl;
  if (!url) throw new AgentStudioError(501, 'agentDesignerProfileUrl non configurato: ramo "descrivi" disattivo');
  const { apiBase } = config();
  const r = await fetch(`${apiBase}${url}`, { cache: 'no-store' });
  if (!r.ok) throw new AgentStudioError(r.status, `designer profile lookup -> ${r.status}`);
  const j = await r.json().catch(() => null);
  if (!(j as any)?.id) throw new AgentStudioError(404, 'profilo "webrobot-agent-designer" non raggiungibile');
  _agentDesignerProfileId = Number((j as any).id);
  return _agentDesignerProfileId;
}

export async function startAgentDesignerRun(goal: string, currentSpec = '{}'): Promise<AgentRun> {
  const profileId = await findAgentDesignerProfileId();
  // `inputs` e' una mappa di STRINGHE: i nomi combaciano con i segnaposto del goal_template del
  // profilo ({goal} e {current_spec}); cambiarli qui li scollega in silenzio.
  return call<AgentRun>('POST', '/api/agentic/start', { profileId, inputs: { goal, current_spec: currentSpec } });
}

export const getAgentRunStatus = (executionId: string) =>
  call<any>('GET', `/api/agentic/${encodeURIComponent(executionId)}`);

/**
 * Il result di un run, letto PER execution_id: lo stato ora lo porta (AgenticApiV10.status). Ripiego
 * sull'elenco `/executions` (chiave `executions`, non `data`) per i backend che non lo espongono
 * ancora. Non si pesca dalle ultime N se lo stato basta: e' l'esito voluto.
 */
export async function getAgentRunResult(executionId: string): Promise<any | null> {
  try {
    const st = await getAgentRunStatus(executionId);
    if (st && st.result != null && st.result !== '') return st.result;
  } catch { /* backend senza result nello stato -> ripiego */ }
  const list = await call<any>('GET', '/api/agentic/executions?limit=100');
  const rows: any[] = Array.isArray(list) ? list : (list?.executions ?? list?.data ?? []);
  const row = rows.find((r) => r?.executionId === executionId);
  return row ? (row.result ?? null) : null;
}

/**
 * Il TESTO grezzo dentro il result, prima di ogni parse. Tre forme: stringa nuda, STRINGA JSON
 * impacchettata (il campo server e' String/JSONB), oggetto `{<nodo>:{<crew>:"<testo>"}}`.
 */
function resultToText(result: any): string | null {
  if (result === null || result === undefined || result === '') return null;
  let r: any = result;
  if (typeof r === 'string') {
    const s = r.trim();
    if (s.startsWith('{') || s.startsWith('[')) { try { r = JSON.parse(s); } catch { return r.trim() || null; } }
  }
  if (typeof r === 'string') return r.trim() || null;
  // se e' gia' l'agent_definition (ha crews) lo si serializza per il passo di parse uniforme
  if (r && typeof r === 'object' && Array.isArray((r as any).crews)) return JSON.stringify(r);
  for (const nodo of Object.values(r as Record<string, any>)) {
    if (typeof nodo === 'string' && nodo.trim()) return nodo.trim();
    if (nodo && typeof nodo === 'object') {
      if (Array.isArray((nodo as any).crews)) return JSON.stringify(nodo);
      for (const v of Object.values(nodo as Record<string, any>)) {
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
  }
  return null;
}

/**
 * La domanda dell'agente quando NON progetta ma chiede (descrizione troppo vaga): "NEEDS: <cosa>".
 * Torna il testo (senza prefisso) o null se e' una proposta vera.
 */
export function extractAgentNeeds(result: any): string | null {
  const t = resultToText(result);
  if (!t) return null;
  const m = t.match(/^NEEDS:\s*([\s\S]*)$/);
  return m ? (m[1].trim() || 'The agent needs more detail to design this.') : null;
}

/**
 * Tira fuori l'agent_definition dal result: apre eventuali recinti markdown, poi JSON.parse. Torna
 * l'oggetto {profile, crews, orchestration?, ...} o null se non c'e' nulla di utilizzabile (incl.
 * il caso NEEDS, che si legge con extractAgentNeeds).
 */
export function extractAgentDefinition(result: any): any | null {
  let t = resultToText(result);
  if (!t) return null;
  if (t.startsWith('NEEDS:')) return null;
  const fence = t.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  // taglia eventuale prosa prima del primo '{'
  const i = t.indexOf('{');
  if (i > 0) t = t.slice(i);
  try {
    const def = JSON.parse(t);
    return def && typeof def === 'object' && Array.isArray(def.crews) ? def : null;
  } catch { return null; }
}

// ── MCP integrations (external MCPs with per-org credentials) ─────────────────
//
// Il `webrobot` full MCP usa il runner-JWT (nessuna credenziale utente). Gli MCP ESTERNI (es.
// Postiz) vogliono una chiave: la si mette in `cloud_credentials` (per org, cifrata), e la spec del
// profilo riferisce solo `${<PROVIDER>_API_KEY}` nell'header — il runner-token la risolve a run time
// (McpIntegrationCredentialResolver). Il catalogo degli MCP integrati e' specifico del cluster
// (URL, provider), quindi lo passa l'HOST via config, non e' cablato qui.
export interface McpIntegration {
  provider: string;      // deve stare in cloud_credentials.provider enum + MCP_INTEGRATION_PROVIDERS
  label: string;         // nome mostrato
  mcpUrl: string;        // url del server MCP a cui l'agente si connette
  apiKeyEnv: string;     // nome env che il runner-token popola (es. POSTIZ_API_KEY) — usato nell'header
  endpoint?: string;     // base url del servizio, salvato sulla cloud_credential
  authScheme?: 'bearer' | 'x-api-key';   // come portare la chiave nell'header (default bearer)
  note?: string;
}

export function getMcpIntegrations(): McpIntegration[] {
  return config().mcpIntegrations || [];
}

/** L'header di auth per un'integrazione, che riferisce l'env (non il segreto). */
export function mcpAuthHeader(integ: McpIntegration): Record<string, string> {
  const ref = '${' + integ.apiKeyEnv + '}';
  return integ.authScheme === 'x-api-key' ? { 'X-API-Key': ref } : { Authorization: `Bearer ${ref}` };
}

/**
 * Salva/aggiorna la credenziale di un'integrazione MCP in cloud_credentials (per org, lato server).
 * Il valore NON entra mai nella spec del profilo. Provider normalizzato a UPPER dal BFF.
 */
export const saveMcpCredential = (provider: string, apiKey: string, opts?: { endpoint?: string; name?: string }) =>
  call<any>('POST', '/api/cloud-credentials', {
    name: opts?.name || `${provider} (Agent Studio)`,
    provider,
    api_key: apiKey,
    ...(opts?.endpoint ? { endpoint: opts.endpoint } : {}),
  });
