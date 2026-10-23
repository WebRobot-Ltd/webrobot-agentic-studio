'use client';

// Agent Studio — the rich FORM editor. Author an agent profile (single) or a
// persistent multi-agent TEAM, then publish it to the marketplace (draft → submit
// → super_admin approve). The authoring surface for the developer / white-label-
// agency roles.
//
// Full parity with the runtime — per-crew engine (agent_sdk | crewai | autogen),
// declared `variables` (the clone-wizard knobs), inline `local_tools` (functionBody,
// no rebuild), pricing (€ → cents) + locked, a visual orchestration GRAPH (React
// Flow) for teams, AND the 📈 Trading layer (bind the strategy-agent to a market,
// pick the asset universe from the tenant allow-list, deploy the bot).
//
// Ported from the WebRobot dashboard page; only the app couplings are removed:
//   · API calls go through the injected client (configureAgentStudio → apiBase + token).
//   · The "design with chat" panel is an injected `chatSlot` (the host passes one).
//   · `editId` is a prop (was read from Next's useSearchParams).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bot, Plus, Trash2, Loader2, Save, Send, Users, Variable, Wrench, Tag, Sparkles, MessageSquare, Info, Network, LineChart, Code2, History } from 'lucide-react';
import TestPanel from './TestPanel';
import { ReactFlow, Background, Controls, type Node, type Edge as FlowEdge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  getAgenticProfile, saveAgenticProfile, publishAgenticProfile,
  allowedAssets, registerStrategy, deployBot as deployBotCall,
  startAgentDesignerRun, extractAgentDefinition, AgentStudioError,
  getMcpIntegrations, mcpAuthHeader, saveMcpCredential, type McpIntegration,
  getAgentProfileDraft, deleteAgentProfileDraft,
  getAgenticProfileVersions, type ProfileVersion,
} from '../client';
import {
  readStoredRun as leggiRun, storeRun as salvaRun, clearStoredRun as scartaRun,
  followAgentDesignerRun, RUN_MAX_AGE_MS,
} from '../agentDesignerRun';

// Contesto del canale draft, uguale al pageContext che DesignWithChat inietta nella chat.
const DRAFT_CTX = 'agentic:agent-studio';

// Left-nav sections of the studio (redesign 10-23). Marketplace and Trading are off the main path:
// most agents are never sold and never trade.
const SECTIONS = [
  { key: 'agents', label: 'Agents', hint: 'Instructions, model, tools', icon: Bot },
  { key: 'team', label: 'Team', hint: 'Chain of hand-offs or swarm', icon: Network },
  { key: 'overview', label: 'Overview', hint: 'Name, surface, description', icon: Info },
  { key: 'tools', label: 'Local tools', hint: 'Inline Python tools', icon: Wrench },
  { key: 'variables', label: 'Variables', hint: 'Knobs buyers configure', icon: Variable },
  { key: 'marketplace', label: 'Marketplace', hint: 'Price, licence, publishing', icon: Tag },
  { key: 'trading', label: 'Trading', hint: 'Bind a strategy to a market', icon: LineChart },
  { key: 'definition', label: 'Definition', hint: 'The generated spec (JSON)', icon: Code2 },
] as const;

const CATEGORIES = [
  'data_engineer', 'scraping_agent', 'research_agent', 'monitoring_agent',
  'social_distribution', 'support_agent', 'rag_assistant', 'analytics_agent',
  'finance', 'multi_agent_team', 'other',
];

// Il run del progettista (RayJob asincrono) si ricorda/riprende via ../agentDesignerRun.
const ENGINES = ['agent_sdk', 'crewai', 'autogen'];
// Models each framework can actually run (agentic-runtime actors): agent_sdk = Claude only; autogen =
// Claude native or gpt-oss on the OpenAI-compatible endpoint (Groq); crewai = LiteLLM ids written to
// llm_default, '' = the model served inside the job (HPC local inference).
const MODELS_BY_ENGINE: Record<string, { id: string; label: string }[]> = {
  agent_sdk: [
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — balanced (default)' },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — hardest tasks' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fast, cheap' },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  ],
  autogen: [
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    { id: 'openai/gpt-oss-120b', label: 'gpt-oss-120b (open, Groq)' },
    { id: 'openai/gpt-oss-20b', label: 'gpt-oss-20b (open, Groq)' },
  ],
  crewai: [
    { id: '', label: 'Model served in the job (HPC local inference)' },
    { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'anthropic/claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    { id: 'groq/openai/gpt-oss-120b', label: 'gpt-oss-120b (open, Groq)' },
    { id: 'groq/openai/gpt-oss-20b', label: 'gpt-oss-20b (open, Groq)' },
  ],
};
const defaultModelFor = (engine: string) => (MODELS_BY_ENGINE[engine] || MODELS_BY_ENGINE.agent_sdk)[0].id;
const PRICE_UNITS = ['free', 'flat', 'subscription_monthly', 'subscription_yearly'];
const BINDS = ['env', 'prompt', 'both'];
// Trading layer (increment 1): a strategy is an AGENT; these fields make it a trading bot.
// Both output modes are agentic — portfolio (fixes target weights, node converges) is the
// validated path; orders (emits orders/signals directly) is the less-mature signal mode.
const TRADING_MODES = [
  { v: 'portfolio', label: 'Portfolio · weights (validated)' },
  { v: 'orders', label: 'Orders · signal (experimental)' },
];
// Venue in MAIUSCOLO come la allow-list di organizations.trading_limits (es. Screebits: ["BINANCE"]).
const VENUES = ['BINANCE', 'BINANCE_TESTNET', 'BYBIT', 'BYBIT_TESTNET'];
const BAR_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];

interface Crew {
  id: string;
  engine: string;
  model: string;
  system_prompt: string;
  // The agent's toolsets: every MCP server, in order (headers/extra keys of each are kept as loaded).
  mcp: McpServer[];
  // Runtime/safety fields — now surfaced in the form (were silently dropped before).
  permission_mode: string;     // '' | 'default' | 'acceptEdits' | 'bypassPermissions'
  disallowed_tools: string;    // comma-separated in the form (e.g. "Bash, mcp__camoufox__agentic_browse")
  max_turns: string;
  max_budget_usd: string;
  // The ORIGINAL crew object as loaded → re-emitted so any field the form doesn't
  // surface (auth, goal_template, multi-server mcp_servers, …) survives a save
  // instead of being stripped. Edited fields override it on emit.
  _raw?: any;
}
const PERMISSION_MODES = ['', 'default', 'acceptEdits', 'bypassPermissions'];
interface McpServer { name: string; type?: string; url: string; allow?: string | string[]; headers?: Record<string, string>; [k: string]: any }
const WEBROBOT_MCP: McpServer = { name: 'webrobot', type: 'http', url: 'https://mcp.webrobot.eu/mcp', allow: 'all' };
interface Edge { from: string; to: string; }
interface VarDecl {
  name: string; label: string; default: string; bind: string;
  secret: boolean; provider: string; description: string;
}
interface LocalTool { name: string; description: string; code: string; }

export interface AgentStudioProps {
  /**
   * Optional "design with chat" panel injected by the host — the same slot the
   * canvas editor uses. The package does not bundle a chat component; the host
   * passes one (e.g. its own DesignWithChat). Rendered in the actions row.
   */
  chatSlot?: ReactNode;
  /** Load an existing agentic profile into the editor by id. Default: null (new). */
  editId?: string | null;
  /** Called after a draft is saved (or updated), with the profile id. */
  onSaved?: (id: string | number) => void;
  /** Called after a bot is deployed, with the registered strategy id. */
  onDeployed?: (strategyId: string | number) => void;
}

// Module-scope so React Flow + the form inputs don't remount on each render.
function OrchestrationGraph({ crews, entry, edges, onConnectEdge, onRemoveEdge, onSetEntry, onOpenAgent }: {
  crews: Crew[]; entry: string; edges: Edge[];
  onConnectEdge?: (from: string, to: string) => void;
  onRemoveEdge?: (from: string, to: string) => void;
  onSetEntry?: (id: string) => void;
  onOpenAgent?: (id: string) => void;
}) {
  // EDITABLE team graph (redesign 10-23, after CrewAI Crew Studio): drag from one agent to another to add a
  // hand-off, double-click an arrow to remove it, click an agent to make it the entry, double-click to open
  // its settings. Positions are kept while the page is open; the spec stores only the edges.
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const nodes: Node[] = crews.map((c, i) => {
    const id = c.id || `n${i}`;
    const isEntry = id === entry;
    return {
      id,
      position: pos[id] || { x: (i % 3) * 250, y: Math.floor(i / 3) * 150 },
      data: {
        label: (
          <div className="text-left">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-900">
              <span className="truncate">{id}</span>
              {isEntry && <span className="rounded bg-brand-600 px-1 text-[10px] font-semibold text-white">entry</span>}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-slate-500">{c.model || 'model?'} · {c.engine}</div>
            <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-slate-600">{c.system_prompt || <i className="text-slate-400">no instructions yet</i>}</div>
          </div>
        ),
      },
      style: {
        border: isEntry ? '2px solid var(--color-brand-600, #4f46e5)' : selected === id ? '2px solid #94a3b8' : '1px solid #cbd5e1',
        borderRadius: 10, padding: 10, background: '#fff', width: 210, boxShadow: '0 1px 2px rgba(0,0,0,.06)',
      },
    };
  });
  const fedges: FlowEdge[] = edges
    .filter((x) => x.from && x.to)
    .map((x, i) => ({ id: `e${i}-${x.from}-${x.to}`, source: x.from, target: x.to, animated: true, data: { from: x.from, to: x.to } }));
  const editable = !!onConnectEdge;
  return (
    <div>
      <div style={{ height: 420 }} className="rounded-lg border border-slate-200 bg-slate-50">
        <ReactFlow
          nodes={nodes} edges={fedges} fitView proOptions={{ hideAttribution: true }}
          nodesDraggable nodesConnectable={editable} elementsSelectable={editable}
          onNodesChange={(chs) => chs.forEach((ch: any) => {
            if (ch.type === 'position' && ch.position) setPos((p) => ({ ...p, [ch.id]: ch.position }));
          })}
          onConnect={(c) => { if (c.source && c.target && c.source !== c.target) onConnectEdge?.(c.source, c.target); }}
          onEdgeDoubleClick={(_, e) => onRemoveEdge?.(String(e.source), String(e.target))}
          onNodeClick={(_, n) => setSelected(String(n.id))}
          onNodeDoubleClick={(_, n) => onOpenAgent?.(String(n.id))}
          onPaneClick={() => setSelected(null)}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {editable && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
          {selected ? (
            <>
              <span>Selected: <b className="text-slate-900">{selected}</b></span>
              {selected !== entry && (
                <button type="button" onClick={() => onSetEntry?.(selected)} className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm font-medium hover:bg-slate-50">Set as entry</button>
              )}
              <button type="button" onClick={() => onOpenAgent?.(selected)} className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm font-medium hover:bg-slate-50">Open settings</button>
            </>
          ) : (
            <span>Drag from one agent's edge to another to add a hand-off · double-click an arrow to remove it · click an agent to select it, double-click to open its settings.</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Esempi della testata: forme reali di agenti che la piattaforma esegue (monitoraggio, sentiment, prezzi). */
const AGENT_EXAMPLES = [
  'A research agent that monitors a topic daily and emails a digest',
  'A sentiment agent that scores news and forum posts about a brand every morning',
  'A team that tracks product prices on shops and alerts me when a competitor undercuts',
];

function AgentStudioInner({ chatSlot, editId = null, onSaved, onDeployed }: AgentStudioProps) {
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('data_engineer');
  const [tags, setTags] = useState('');
  const [crews, setCrews] = useState<Crew[]>([
    { id: 'agent', engine: 'agent_sdk', model: 'claude-sonnet-5-5', system_prompt: 'You are a helpful WebRobot agent.', mcp: [{ ...WEBROBOT_MCP }], permission_mode: '', disallowed_tools: '', max_turns: '', max_budget_usd: '' },
  ]);
  const [entry, setEntry] = useState('agent');
  const [edges, setEdges] = useState<Edge[]>([]);
  // Team kind (10-23): a CHAIN of hand-offs (orchestration dag) or a SWARM — agents working in parallel on a
  // shared workspace + task board (orchestration swarm: replicas per crew, seed tasks, optional lead).
  const [teamKind, setTeamKind] = useState<'chain' | 'swarm'>('chain');
  const [swarmReplicas, setSwarmReplicas] = useState<Record<string, number>>({});
  const [swarmLead, setSwarmLead] = useState('');
  const [seedTasks, setSeedTasks] = useState('');
  const [swarmMaxMin, setSwarmMaxMin] = useState('30');
  const [requiredCaps, setRequiredCaps] = useState('webrobot_mcp');
  const [variables, setVariables] = useState<VarDecl[]>([]);
  const [localTools, setLocalTools] = useState<LocalTool[]>([]);
  const [priceUnit, setPriceUnit] = useState('free');
  const [priceEur, setPriceEur] = useState('0');
  const [locked, setLocked] = useState(false);
  const [revenueShare, setRevenueShare] = useState('70');

  // ── Trading layer (increment 1) ──────────────────────────────────────────
  const [tradingEnabled, setTradingEnabled] = useState(false);
  const [tradingMode, setTradingMode] = useState('portfolio');   // portfolio | orders
  const [universe, setUniverse] = useState('');                  // comma-sep symbols (asset universe)
  const [venue, setVenue] = useState('BINANCE');
  const [barInterval, setBarInterval] = useState('1h');
  const [tradingCredential, setTradingCredential] = useState(''); // cloud_credential name/id (exchange)
  const [maxExposurePct, setMaxExposurePct] = useState('30');
  const [maxDrawdownPct, setMaxDrawdownPct] = useState('20');
  const [killSwitch, setKillSwitch] = useState(true);
  // Per conto di quale tenant (super_admin); vuoto = la propria org. Alimenta sia gli asset
  // consentiti sia il deploy (?organizationId).
  const [tradingOrgId, setTradingOrgId] = useState('');
  // Allow-list letta dal tenant (organizations.trading_limits) — così l'utente SCEGLIE, non indovina.
  const [allowed, setAllowed] = useState<{ enabled: boolean; venues: string[]; instruments: string[] } | null>(null);
  const [allowedErr, setAllowedErr] = useState<string | null>(null);

  useEffect(() => {
    if (!tradingEnabled) { setAllowed(null); setAllowedErr(null); return; }
    allowedAssets(tradingOrgId.trim() || undefined)
      .then((d: any) => {
        if (d?.error) { setAllowed(null); setAllowedErr(d.error); return; }
        setAllowedErr(null);
        setAllowed({ enabled: !!d.enabled, venues: d.venues || [], instruments: d.instruments || [] });
      })
      .catch((e: any) => { setAllowed(null); setAllowedErr(String(e?.message || e)); });
  }, [tradingEnabled, tradingOrgId]);

  // Toggle di uno strumento nell'universo (comma-list).
  const universeSet = universe.split(',').map((s) => s.trim()).filter(Boolean);
  const toggleSym = (sym: string) => {
    const has = universeSet.includes(sym);
    const next = has ? universeSet.filter((s) => s !== sym) : [...universeSet, sym];
    setUniverse(next.join(', '));
  };

  const [status, setStatus] = useState<string>('new');
  // chat = persona shown in the chat picker · background = CrewAI/Ray batch (default).
  const [surface, setSurface] = useState<string>('background');
  // EXPLICIT structure (no longer inferred from crew count):
  //   single = independent agent(s) — 1 is a single agent, N are independent PERSONAS
  //            (chat picker lists each; NO orchestration DAG).
  //   team   = N agents that COLLABORATE via an orchestration DAG (chat_mode: team).
  const [mode, setMode] = useState<'single' | 'team'>('single');
  const [savedId, setSavedId] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [section, setSection] = useState<string>('agents');
  const [testOpen, setTestOpen] = useState(true);
  const openAgent = (id: string) => {
    setSection('agents');
    setTimeout(() => document.getElementById(`crew-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  };
  // The spec as last saved/loaded: the test panel runs the SAVED profile, so it warns on unsaved edits.
  const [savedSpec, setSavedSpec] = useState<string | null>(null);
  const markSaved = useRef(false);
  const [versions, setVersions] = useState<ProfileVersion[] | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const openVersions = async () => {
    if (versionsOpen) { setVersionsOpen(false); return; }
    setVersionsOpen(true); setVersions(null);
    try { setVersions(savedId != null ? await getAgenticProfileVersions(String(savedId)) : []); }
    catch { setVersions([]); }
  };

  // Ramo "descrivi il team -> l'agente lo progetta" (parita' col pipeline designer).
  const [askText, setAskText] = useState('');
  const [generating, setGenerating] = useState(false);
  const [askPhase, setAskPhase] = useState<string | null>(null);
  const [askErr, setAskErr] = useState<string | null>(null);
  const [proposal, setProposal] = useState<any | null>(null);       // agent_definition proposto
  const proposalRef = useRef<any | null>(null); proposalRef.current = proposal;   // per il polling draft
  const runCtx = editId ? String(editId) : 'new';

  // MCP integrati (con credenziali per-org). Catalogo dall'host; input chiave e stato per (crew,provider).
  const mcpIntegrations = getMcpIntegrations();
  const [intgKey, setIntgKey] = useState<Record<string, string>>({});
  const [intgMsg, setIntgMsg] = useState<Record<string, string>>({});

  const isTeam = mode === 'team';   // explicit, not inferred from crew count
  const isPaid = priceUnit !== 'free' && Number(priceEur) > 0;

  // Applica un agent_definition (def) al form. PURA: nessuna fetch. La usano sia il caricamento di
  // un profilo salvato sia l'APPLY di una proposta dell'agente progettista — un solo punto che sa
  // tradurre lo spec in stato del form, cosi' i due ingressi non divergono. `meta` porta i campi del
  // record salvato (id/status/surface/name/version/description) quando ci sono; per una proposta e'
  // assente e si usano quelli dentro def (profile/display_name/description).
  const applySpec = useCallback((def: any, meta?: {
    id?: string | number; status?: string; surface?: string; name?: string; version?: string; description?: string;
  }) => {
    def = def || {};
    if (meta?.id != null) { setSavedId(Number(meta.id)); markSaved.current = true; }
    if (meta?.status) setStatus(meta.status);
    if (meta?.surface) setSurface(meta.surface);
    setMode(def.chat_mode === 'team' ? 'team' : 'single');
    setCode(def.profile || meta?.name || '');
    setDisplayName(meta?.name || def.display_name || def.profile || '');
    setVersion(meta?.version || def.version || '1.0.0');
    setDescription(meta?.description || def.description || '');
    const cs: Crew[] = (def.crews || []).map((c: any) => ({
      id: c.id || 'agent', engine: c.engine || 'agent_sdk',
      model: (c.engine || '').toLowerCase() === 'crewai' ? (c.llm_default || c.model || '') : (c.model || 'claude-sonnet-5-5'),
      system_prompt: c.system_prompt || '', mcp: Array.isArray(c.mcp_servers) ? c.mcp_servers.map((m: any) => ({ ...m })) : [],
      permission_mode: c.permission_mode || '',
      disallowed_tools: Array.isArray(c.disallowed_tools) ? c.disallowed_tools.join(', ') : (c.disallowed_tools || ''),
      max_turns: c.max_turns != null ? String(c.max_turns) : '',
      max_budget_usd: c.max_budget_usd != null ? String(c.max_budget_usd) : '',
      _raw: c,   // preserve every field (auth, goal_template, multi-server mcp, …) for round-trip
    }));
    if (cs.length) setCrews(cs);
    setEntry(def.orchestration?.entry || cs[0]?.id || 'agent');
    setEdges(def.orchestration?.edges || []);
    const orch = def.orchestration || {};
    if (orch.type === 'swarm') {
      setTeamKind('swarm');
      const rep: Record<string, number> = {};
      for (const a of orch.agents || []) if (a?.crew) rep[a.crew] = Number(a.replicas || 1);
      setSwarmReplicas(rep);
      setSwarmLead(orch.lead || '');
      setSeedTasks(Array.isArray(orch.seed_tasks) ? orch.seed_tasks.join('\n') : '');
      setSwarmMaxMin(orch.max_seconds ? String(Math.round(Number(orch.max_seconds) / 60)) : '30');
    } else {
      setTeamKind('chain');
    }
    // variables / local_tools live on the crew node (authored profile-wide).
    const c0 = (def.crews || [])[0] || {};
    if (Array.isArray(c0.variables)) setVariables(c0.variables.map((v: any) => ({
      name: v.name || '', label: v.label || '', default: v.default != null ? String(v.default) : '',
      bind: v.bind || 'env', secret: !!v.secret, provider: v.provider || '', description: v.description || '',
    })));
    if (Array.isArray(c0.local_tools)) setLocalTools(c0.local_tools.map((t: any) => ({
      name: t.name || '', description: t.description || '', code: t.code || t.functionBody || '',
    })));
    // Trading binding (increment 1) — round-trip so a re-edit doesn't drop it.
    if (def.trading) {
      const tr = def.trading;
      setTradingEnabled(true);
      setTradingMode(tr.mode || 'portfolio');
      setUniverse(Array.isArray(tr.universe) ? tr.universe.join(', ') : (tr.universe || ''));
      setVenue(tr.venue || 'BINANCE');
      setBarInterval(tr.bar_interval || '1h');
      setTradingCredential(tr.credential_ref || '');
      const rk = tr.risk || {};
      setMaxExposurePct(rk.max_exposure_pct != null ? String(rk.max_exposure_pct) : '30');
      setMaxDrawdownPct(rk.max_drawdown_pct != null ? String(rk.max_drawdown_pct) : '20');
      setKillSwitch(rk.kill_switch !== false);
    }
  }, []);

  // Load a PROFILE (Jersey agentic_profiles) into the editor — unified store.
  const loadProfile = (id: string | number) => {
    getAgenticProfile(String(id))
      .then((d: any) => {
        if (d?.error) { setMsg({ kind: 'err', text: d.error }); return; }
        let def: any = {};
        try { def = typeof d.spec === 'string' ? JSON.parse(d.spec) : (d.spec || {}); } catch { def = {}; }
        applySpec(def, {
          id: d.id, status: d.status || 'draft', surface: d.surface || 'background',
          name: d.name, version: d.version, description: d.description,
        });
      })
      .catch((e: any) => setMsg({ kind: 'err', text: e.message }));
  };
  useEffect(() => { if (editId) loadProfile(editId); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [editId]);

  // Variables + local_tools are authored profile-wide and attached to EACH crew node,
  // which is where the runner (build_options / crew_actor) reads them.
  const declaredVars = useMemo(() => variables.filter((v) => v.name.trim()).map((v) => ({
    name: v.name.trim(),
    ...(v.label ? { label: v.label } : {}),
    ...(v.default !== '' ? { default: v.default } : {}),
    ...(v.secret ? { secret: true } : { bind: v.bind }),
    ...(v.provider ? { provider: v.provider } : {}),
    ...(v.description ? { description: v.description } : {}),
  })), [variables]);
  const declaredTools = useMemo(() => localTools.filter((t) => t.name.trim() && t.code.trim()).map((t) => ({
    name: t.name.trim(), description: t.description || t.name.trim(), params: {}, code: t.code,
  })), [localTools]);

  const agentDefinition = useMemo(() => {
    const splitCsv = (s: string) => (s || '').split(',').map((t) => t.trim()).filter(Boolean);
    const def: any = {
      profile: code || 'profile',
      crews: crews.map((c) => {
        // Start from the ORIGINAL crew → every field the form doesn't surface
        // (auth, goal_template, extra mcp_servers, …) is preserved across the save.
        const out: any = { ...(c._raw || {}) };
        out.id = c.id; out.engine = c.engine; out.system_prompt = c.system_prompt;
        // crewai reads llm_default (LiteLLM id), not model; empty = the job's local model
        if (c.engine === 'crewai') { delete out.model; if (c.model) out.llm_default = c.model; else delete out.llm_default; }
        else { out.model = c.model; }
        // MCP: the form edits the whole list (empty url rows are dropped).
        const servers = c.mcp.filter((m) => (m.url || '').trim()).map((m) => ({ type: 'http', allow: 'all', ...m, url: m.url.trim() }));
        if (servers.length) out.mcp_servers = servers; else delete out.mcp_servers;
        // Surfaced runtime/safety fields (empty → omitted / cleared)
        if (c.permission_mode) out.permission_mode = c.permission_mode; else delete out.permission_mode;
        const dt = splitCsv(c.disallowed_tools); if (dt.length) out.disallowed_tools = dt; else delete out.disallowed_tools;
        if (String(c.max_turns).trim()) out.max_turns = Number(c.max_turns); else delete out.max_turns;
        if (String(c.max_budget_usd).trim()) out.max_budget_usd = Number(c.max_budget_usd); else delete out.max_budget_usd;
        // Profile-wide knobs attached to each crew node
        if (declaredVars.length) out.variables = declaredVars; else delete out.variables;
        if (declaredTools.length) out.local_tools = declaredTools; else delete out.local_tools;
        return out;
      }),
    };
    if (isTeam) {
      def.chat_mode = 'team';
      // `nodes` is what the Ray runner builds its topological order from. Emitting only
      // {entry, edges} left it empty, and its emptiness check compares len(order) to len(nodes)
      // — 0 to 0 — so a studio-authored team RAN, reported SUCCEEDED and executed no agent at
      // all. One node per crew, id == crew id, which is what these edges already reference.
      def.orchestration = teamKind === 'swarm'
        ? {
            type: 'swarm',
            agents: crews.filter((c: any) => c.id !== swarmLead).map((c: any) => ({ crew: c.id, replicas: Math.max(1, Number(swarmReplicas[c.id] || 1)) })),
            ...(seedTasks.trim() ? { seed_tasks: seedTasks.split('\n').map((t) => t.trim()).filter(Boolean) } : {}),
            ...(swarmLead ? { lead: swarmLead } : {}),
            max_seconds: Math.max(60, Math.round(Number(swarmMaxMin || '30') * 60)),
          }
        : {
            type: 'dag',
            entry,
            nodes: crews.map((c: any) => ({ id: c.id, crew: c.id })),
            edges,
          };
    }
    if (tradingEnabled) {
      // The strategy stays purely agentic; this block only BINDS it to trading (universe/venue/
      // credentials/risk) — the runner + deploy route read it. weights_pct is per-asset, so the
      // universe is the set of symbols the agent fixes weights over.
      const syms = universe.split(',').map((s) => s.trim()).filter(Boolean);
      def.trading = {
        mode: tradingMode,                       // portfolio (target weights) | orders (signal)
        venue,
        universe: syms,                          // asset universe — monitored + allocated over
        bar_interval: barInterval,               // one bar_interval — backtest/live parity
        ...(tradingCredential ? { credential_ref: tradingCredential } : {}),
        risk: {
          max_exposure_pct: Number(maxExposurePct) || 0,
          max_drawdown_pct: Number(maxDrawdownPct) || 0,   // metrics-as-constraint (à la Screebits)
          kill_switch: killSwitch,
        },
      };
    }
    return def;
  }, [code, crews, isTeam, entry, edges, teamKind, swarmReplicas, swarmLead, seedTasks, swarmMaxMin, declaredVars, declaredTools,
      tradingEnabled, tradingMode, venue, universe, barInterval, tradingCredential,
      maxExposurePct, maxDrawdownPct, killSwitch]);
  useEffect(() => {
    if (markSaved.current) { markSaved.current = false; setSavedSpec(JSON.stringify(agentDefinition)); }
  }, [agentDefinition]);
  const dirty = savedSpec != null && savedSpec !== JSON.stringify(agentDefinition);

  // ── "Descrivi il team -> l'agente lo progetta" ────────────────────────────────
  // Speculare a askForPipeline del pipeline designer: si avvia `webrobot-agent-designer`, se ne fa
  // polling, se ne legge il result (l'agent_definition), lo si MOSTRA come proposta; l'utente la
  // applica al form (applySpec) o la scarta. Il run e' di background: sopravvive a timeout/chiusura.

  // Segue un run fino all'esito e ne propone il risultato. Condiviso fra avvio inline e ripresa su
  // mount. Controlla lo stato PRIMA di dormire, cosi' un run gia' finito si propone subito.
  const seguiRun = useCallback(async (eid: string) => {
    setGenerating(true); setAskErr(null); setAskPhase('The designer agent is working…');
    try {
      const esito = await followAgentDesignerRun(eid,
        (stato) => setAskPhase(`The designer agent is working… (${stato.toLowerCase() || 'running'})`));
      if (esito.kind === 'pending') {
        setAskErr('The agent is taking a while — you can leave this page; the proposal will appear here when it finishes.');
        return;
      }
      scartaRun(runCtx);
      if (esito.kind === 'ended') { setAskErr(`The agent run ended as ${esito.status}.`); return; }
      if (esito.kind === 'needs') { setAskErr(`The agent needs more detail: ${esito.question}`); return; }
      if (esito.kind === 'empty') {
        setAskErr('The agent finished without a usable profile — try describing the agent and what it should do more concretely.');
        return;
      }
      const def = esito.def;
      setProposal(def);          // non si applica da soli: si mostra e l'utente decide
    } catch (e) {
      setAskErr(e instanceof AgentStudioError ? `agent → ${e.status}` : 'The designer agent could not be reached');
    } finally { setGenerating(false); setAskPhase(null); }
  }, [runCtx]);

  const askForAgent = useCallback(async () => {
    const prompt = askText.trim();
    if (!prompt) return;
    setAskErr(null); setProposal(null); setGenerating(true); setAskPhase('Starting the designer agent…');
    let eid: string | undefined;
    try {
      // Lo spec corrente (vuoto {} per un profilo nuovo) va all'agente cosi' MODIFICA invece di
      // ripartire da zero — il goal_template lo inietta come {current_spec}.
      const currentSpec = crews.length ? JSON.stringify(agentDefinition) : '{}';
      const run = await startAgentDesignerRun(prompt, currentSpec);
      eid = run?.executionId;
    } catch (e) {
      setAskErr(e instanceof AgentStudioError ? `agent → ${e.status}` : 'The designer agent could not be reached');
      setGenerating(false); setAskPhase(null); return;
    }
    if (!eid) { setAskErr('The agent did not start.'); setGenerating(false); setAskPhase(null); return; }
    salvaRun(runCtx, { executionId: eid, prompt, startedAt: Date.now() });   // ricorda PRIMA di attendere
    await seguiRun(eid);
  }, [askText, crews, agentDefinition, runCtx, seguiRun]);

  // updatedAt dell'ultimo draft gia' consumato/scartato: senza, il polling lo riproporrebbe subito.
  const draftSeen = useRef<string | null>(null);

  const applyProposal = useCallback(() => {
    if (!proposal) return;
    applySpec(proposal);            // meta assente: usa profile/display_name/description dentro def
    setProposal(null);
    deleteAgentProfileDraft(DRAFT_CTX).catch(() => {});   // consumato: svuota il canale
    setMsg({ kind: 'ok', text: 'Proposal applied to the form — review and tweak, then Save draft.' });
  }, [proposal, applySpec]);

  const discardProposal = useCallback(() => {
    setProposal(null);
    deleteAgentProfileDraft(DRAFT_CTX).catch(() => {});
  }, []);

  // POLLING del canale draft: quando la chat (Guided o Design-with-chat) scrive un profilo, lo
  // studio lo raccoglie e lo mostra come proposta — il resync che mancava. `draftSeen` evita di
  // riproporre lo stesso draft dopo che e' stato applicato/scartato. Non tocca una proposta gia'
  // a schermo (es. quella inline di "Propose").
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const d = await getAgentProfileDraft(DRAFT_CTX);
      if (!alive || !d) return;
      if (d.updatedAt && d.updatedAt === draftSeen.current) return;
      if (proposalRef.current) return;                    // non sovrascrivo una proposta gia' aperta
      const def = extractAgentDefinition(d.profileSpec);
      if (!def) return;
      draftSeen.current = d.updatedAt || String(Date.now());
      setProposal(def);
    };
    const h = setInterval(tick, 4000);
    tick();
    return () => { alive = false; clearInterval(h); };
  }, []);

  // Ripresa su mount: se c'e' un run salvato e recente per questa sessione, lo si riprende.
  const seguiRunRef = useRef(seguiRun);
  seguiRunRef.current = seguiRun;
  useEffect(() => {
    const stored = leggiRun(runCtx);
    if (!stored) return;
    if (Date.now() - stored.startedAt > RUN_MAX_AGE_MS) { scartaRun(runCtx); return; }
    setAskText((t) => t || stored.prompt);
    seguiRunRef.current(stored.executionId);
  }, [runCtx]);

  // Unified store: Studio authors a Jersey agentic_profile (spec = agent_definition);
  // publishing creates a Jersey marketplace listing (pending_approval). Same store the
  // clone wizard reads/clones from — no more Strapi agent-templates divergence.
  const csv = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean);

  const saveDraft = async () => {
    setBusy('save'); setMsg(null);
    try {
      const profileBody = {
        name: (code || displayName || 'agent-profile').trim(),
        version, description, surface,
        spec: JSON.stringify(agentDefinition),
      };
      const j = await saveAgenticProfile(profileBody, savedId != null ? String(savedId) : undefined);
      const id = j?.id ?? j?.data?.id ?? savedId;
      setSavedId(id); setStatus('draft'); setSavedSpec(JSON.stringify(agentDefinition));
      setMsg({ kind: 'ok', text: `Profile saved (id ${id}).` });
      if (id != null) onSaved?.(id);
      return id;
    } catch (e: any) { setMsg({ kind: 'err', text: e.message }); return null; }
    finally { setBusy(null); }
  };

  const submitForApproval = async () => {
    const id = savedId || (await saveDraft());
    if (!id) return;
    setBusy('submit'); setMsg(null);
    try {
      const j = await publishAgenticProfile({
        profileId: id,
        displayName: (displayName || code).trim(),
        description, category,
        tags: csv(tags),
        priceUnit,
        priceAmount: Math.round(Number(priceEur || '0') * 100), // € → cents
        locked: isPaid ? true : locked,
        revenueSharePercent: Number(revenueShare) || 0,
        requiredCapabilities: csv(requiredCaps),
        ipDisclaimerAccepted: true,
      });
      setStatus('pending_approval');
      setMsg({ kind: 'ok', text: `Published for approval (listing ${j?.id ?? '?'}) — a super_admin will review it before it goes public.` });
    } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
    finally { setBusy(null); }
  };

  // Deploy bot (incremento 2): registra la strategia-agente nel registro (kind: agentic) → strategyId,
  // poi avvia il bot. I guardrail (trading abilitato, tetto, allow-list) li applica Jersey; un
  // super_admin senza org numerica riceve un 400 chiaro che chiede ?organizationId del tenant.
  const deployBot = async () => {
    const syms = universe.split(',').map((s) => s.trim()).filter(Boolean);
    if (!syms.length) { setMsg({ kind: 'err', text: 'Define at least one asset in the universe.' }); return; }
    if (!venue) { setMsg({ kind: 'err', text: 'Choose a venue.' }); return; }
    setBusy('deploy'); setMsg(null);
    try {
      // 1) registra la strategia agentica → strategyId
      const sj = await registerStrategy({
        name: (code || displayName || 'strategy').trim(),
        kind: 'agentic',
        spec: JSON.stringify(agentDefinition),
        enabled: true,
        ...(tradingOrgId.trim() ? { organizationId: tradingOrgId.trim() } : {}),
      });
      const strategyId = sj?.id ?? sj?.data?.id;
      if (!strategyId) throw new Error('Strategy registry did not return a strategyId');
      // 2) avvia il bot (universo → instruments per il portfolio manager; singolo → instrument)
      const deployBody: Record<string, unknown> = { strategyId, venue, mode: tradingMode };
      if (tradingMode === 'portfolio') deployBody.instruments = syms.join(',');
      else deployBody.instrument = syms[0];
      await deployBotCall(deployBody, tradingOrgId.trim() || undefined);
      setMsg({ kind: 'ok', text: `Bot started (strategyId ${strategyId}). You can find it under Trading.` });
      onDeployed?.(strategyId);
    } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
    finally { setBusy(null); }
  };

  const setCrew = (i: number, patch: Partial<Crew>) =>
    setCrews((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  // ── MCP integrati: aggancio/sgancio al crew + salvataggio chiave (per org) ──
  // L'integrazione e' un mcp_servers aggiuntivo (in _raw, preservato dal builder oltre il primario):
  // url dell'MCP + header che RIFERISCE l'env (${PROVIDER_API_KEY}), mai il segreto. Il segreto va in
  // cloud_credentials (saveMcpCredential) e il runner-token lo risolve a run time.
  const crewServers = (c: Crew): McpServer[] => c.mcp || [];
  const attachIntegration = (i: number, c: Crew, integ: McpIntegration) => {
    const servers = [...crewServers(c)];
    if (!servers.some((s) => s?.url === integ.mcpUrl)) {
      servers.push({ name: integ.provider, type: 'http', url: integ.mcpUrl, allow: 'all', headers: mcpAuthHeader(integ) });
    }
    setCrew(i, { mcp: servers });
  };
  const detachIntegration = (i: number, c: Crew, integ: McpIntegration) => {
    const servers = crewServers(c).filter((s) => s?.url !== integ.mcpUrl);
    setCrew(i, { mcp: servers });
  };
  const saveIntegrationKey = async (i: number, integ: McpIntegration) => {
    const k = `${i}:${integ.provider}`;
    const key = (intgKey[k] || '').trim();
    if (!key) return;
    setIntgMsg((m) => ({ ...m, [k]: 'saving…' }));
    try {
      await saveMcpCredential(integ.provider, key, { endpoint: integ.endpoint });
      setIntgMsg((m) => ({ ...m, [k]: 'saved ✓ — stored securely for your organization' }));
      setIntgKey((m) => ({ ...m, [k]: '' }));
    } catch (e) {
      setIntgMsg((m) => ({ ...m, [k]: e instanceof AgentStudioError ? `save → ${e.status}` : 'save failed' }));
    }
  };
  const addCrew = () => setCrews((cs) => [...cs, { id: `agent${cs.length + 1}`, engine: 'agent_sdk', model: 'claude-sonnet-5-5', system_prompt: '', mcp: [{ ...WEBROBOT_MCP }], permission_mode: '', disallowed_tools: '', max_turns: '', max_budget_usd: '' }]);
  const removeCrew = (i: number) => setCrews((cs) => cs.filter((_, j) => j !== i));

  const setVar = (i: number, patch: Partial<VarDecl>) =>
    setVariables((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const addVar = () => setVariables((vs) => [...vs, { name: '', label: '', default: '', bind: 'prompt', secret: false, provider: '', description: '' }]);
  const removeVar = (i: number) => setVariables((vs) => vs.filter((_, j) => j !== i));

  const setTool = (i: number, patch: Partial<LocalTool>) =>
    setLocalTools((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const addTool = () => setLocalTools((ts) => [...ts, { name: '', description: '', code: 'return {"ok": True}' }]);
  const removeTool = (i: number) => setLocalTools((ts) => ts.filter((_, j) => j !== i));

  return (
    <div className="w-full px-2 py-6 text-slate-900">
      {/* HERO (restyling 10-22, stile Databricks / Snowflake): titolo e le due VIE FACILI — descrivere in
          una riga (l'agente progettista webrobot-agent-designer propone) o conversare (chatSlot) — in una
          sola testata. Prima erano una fascia blu e, sotto, un riquadro "Start here": il nuovo utente
          leggeva due intestazioni prima di trovare il campo. Il form tecnico resta sotto, invariato. */}
      {editId ? (
        // Editing an existing agent: the describe-to-change bar, compact — the studio below is the work area.
        <div className="mb-4 rounded-xl border border-brand-200 bg-brand-50 p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Sparkles className="hidden h-5 w-5 shrink-0 text-brand-600 sm:block" />
            <input
              className="min-w-0 flex-1 rounded-lg border border-brand-200 bg-white px-3 py-2.5 text-base text-slate-900 outline-none placeholder:text-slate-400 focus:border-brand-400"
              placeholder="Describe a change — e.g. “add a reviewer agent that checks the report before it is sent”"
              value={askText}
              onChange={(e) => setAskText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') askForAgent(); }}
              disabled={generating}
            />
            <button type="button" onClick={askForAgent} disabled={generating || !askText.trim()}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-brand-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-950 disabled:opacity-50">
              {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {generating ? 'Designing…' : 'Propose change'}
            </button>
            {chatSlot && <div className="shrink-0">{chatSlot}</div>}
          </div>
          {askPhase && !askErr && <p className="mt-2 text-sm text-slate-700">{askPhase}</p>}
          {askErr && <p className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">{askErr}</p>}
        </div>
      ) : (
      <section className="relative mb-6 overflow-hidden rounded-2xl bg-gradient-to-br from-brand-950 via-brand-900 to-brand-700 p-6 text-white shadow-lg sm:p-8">
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-brand-400/25 blur-3xl" />
        <div className="absolute -right-8 -top-10 opacity-10" aria-hidden="true"><Bot className="h-40 w-40" /></div>
        <div className="relative">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-2.5 py-0.5 text-xs font-semibold text-brand-200">
              <Bot className="h-3.5 w-3.5" /> Agent Studio
            </span>
            {isTeam && <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-xs"><Users className="h-3 w-3" /> Team</span>}
            <span className="ml-auto text-xs text-white/75">status: <b className="text-white">{status}</b>{savedId ? ` · id ${savedId}` : ''}</span>
          </div>
          <h1 className="mt-3 text-2xl font-extrabold tracking-tight sm:text-3xl">
            {editId ? 'Describe a change. The assistant redesigns your agent.' : 'Describe your agent. The assistant designs it.'}
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-blue-100 sm:text-base">
            {editId
              ? 'Describe a change and the assistant redesigns this agent — or edit the form below.'
              : 'Describe the agent — or the team — you want and the assistant designs it for you, ready to review and tweak below. Prefer to build it by hand? Fill in the form.'}
          </p>
          <div className="mt-5 flex flex-col gap-2 rounded-xl bg-white p-2 shadow-xl shadow-black/20 sm:flex-row sm:items-center">
            <input
              className="min-w-0 flex-1 rounded-lg border-0 px-3 py-3 text-base text-slate-900 outline-none placeholder:text-slate-400"
              placeholder="Describe the agent or team — e.g. “a research agent that monitors a topic daily and emails a digest”"
              value={askText}
              onChange={(e) => setAskText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') askForAgent(); }}
              disabled={generating}
            />
            <button
              type="button"
              onClick={askForAgent}
              disabled={generating || !askText.trim()}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-brand-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-950 disabled:opacity-50"
              title="Design an agent from this description — you review it before anything changes"
            >
              {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {generating ? 'Designing…' : 'Propose'}
            </button>
          </div>
          {chatSlot && <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-blue-100">or {chatSlot}</div>}
          {askPhase && !askErr && <p className="mt-2 text-sm text-blue-100">{askPhase}</p>}
          {askErr && <p className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">{askErr}</p>}
          {/* Partenze concrete solo per un profilo nuovo e finche' il campo e' vuoto. */}
          {!editId && !askText.trim() && !generating && !proposal && (
            <div className="mt-6">
              <p className="text-xs font-semibold uppercase tracking-wider text-blue-200">Start from an example</p>
              <div className="mt-2 grid gap-3 sm:grid-cols-3">
                {AGENT_EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => setAskText(ex)}
                    className="rounded-xl border border-white/15 bg-white/[0.07] p-3 text-left text-sm text-blue-50 transition hover:border-white/40 hover:bg-white/[0.14]"
                  >
                    {ex}
                    <span className="mt-2 block text-xs font-semibold text-brand-200">Use this →</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
      )}

      {/* La proposta dell'agente progettista: non applicata da sola, si vede e si decide. */}
      {proposal && (
        <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-emerald-900">
              🤖 Proposed {proposal.chat_mode === 'team' ? `team of ${(proposal.crews || []).length} agents` : 'agent'}
            </span>
            {(proposal.display_name || proposal.profile) && (
              <span className="rounded border border-emerald-200 bg-white px-1.5 py-0.5 text-xs text-emerald-700">
                {proposal.display_name || proposal.profile}
              </span>
            )}
            {Array.isArray(proposal.crews) && proposal.crews.length > 0 && (
              <span className="text-xs text-emerald-700">
                {proposal.crews.map((c: any) => c.id).filter(Boolean).join(' · ')}
              </span>
            )}
            <span className="flex-1" />
            <button type="button" onClick={applyProposal}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700">
              Apply to the form
            </button>
            <button type="button" onClick={discardProposal}
              className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-white">
              Discard
            </button>
          </div>
          {proposal.description && <p className="mt-1 text-sm text-emerald-900">{proposal.description}</p>}
          <details className="mt-2">
            <summary className="cursor-pointer text-sm text-emerald-800">See the proposed definition</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-emerald-200 bg-white p-2 text-[11px] leading-snug">{JSON.stringify(proposal, null, 2)}</pre>
          </details>
        </div>
      )}

      {msg && (
        <div className={`mb-4 rounded-lg border p-3 text-sm ${msg.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>{msg.text}</div>
      )}

      {/* STUDIO (redesign 10-23, after Relevance AI / Copilot Studio / CrewAI): one section at a time from
          the left nav instead of seven stacked cards, and a TEST panel on the right — talk to the agent and
          see each step it takes. Publishing-only (Marketplace) and trading-only fields leave the main path. */}
      <div className="sticky top-0 z-10 mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
        <Bot className="h-5 w-5 text-brand-600" />
        <span className="text-lg font-semibold text-slate-900">{displayName || code || 'New agent'}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${status === 'draft' || status === 'new' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>{status}</span>
        {isTeam && <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700"><Users className="h-3 w-3" /> Team · {crews.length}</span>}
        {dirty && <span className="text-xs text-slate-500">unsaved changes</span>}
        <span className="flex-1" />
        <div className="relative">
          <button onClick={openVersions} disabled={savedId == null} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            title={savedId == null ? 'Save the agent to start its history' : 'Earlier versions of this agent'}>
            <History className="h-4 w-4" /> Versions
          </button>
          {versionsOpen && (
            <div className="absolute right-0 z-20 mt-2 w-96 rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
              {versions == null && <p className="flex items-center gap-2 p-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}
              {versions && versions.length === 0 && <p className="p-2 text-sm text-slate-500">No earlier versions yet — every save from now on keeps the one it replaces.</p>}
              {versions && versions.length > 0 && (
                <ul className="max-h-80 space-y-1 overflow-y-auto">
                  {versions.map((v) => (
                    <li key={v.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-slate-900">v{v.version || '?'} <span className="font-normal text-slate-500">· {v.savedAt ? new Date(v.savedAt).toLocaleString() : ''}</span></span>
                        <span className="block truncate text-xs text-slate-500">{v.description || v.name}</span>
                      </span>
                      <button type="button" className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium hover:bg-white"
                        onClick={() => {
                          try {
                            applySpec(JSON.parse(v.spec || '{}'), { name: v.name, version: v.version, description: v.description, surface: v.surface });
                            setVersionsOpen(false);
                            setMsg({ kind: 'ok', text: `Version ${v.version || ''} loaded into the form — Save to make it current.` });
                          } catch { setMsg({ kind: 'err', text: 'That version could not be read.' }); }
                        }}>Load</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        {/* Two definition modes (10-23): the FORM (sections) and the GRAPH of the team (chain or swarm). */}
        <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 text-sm" role="tablist" aria-label="Definition mode">
          {([['form', 'Form'], ['graph', 'Graph']] as const).map(([k, l]) => {
            const on = k === 'graph' ? section === 'team' : section !== 'team';
            return (
              <button key={k} type="button" role="tab" aria-selected={on}
                onClick={() => setSection(k === 'graph' ? 'team' : 'agents')}
                className={`rounded-md px-3 py-1.5 font-medium ${on ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{l}</button>
            );
          })}
        </div>
        <button onClick={() => setTestOpen((v) => !v)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
          <MessageSquare className="h-4 w-4" /> {testOpen ? 'Hide test' : 'Test'}
        </button>
        <button onClick={saveDraft} disabled={!!busy} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
          {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
        </button>
        <button onClick={submitForApproval} disabled={!!busy} className="inline-flex items-center gap-2 rounded-lg bg-brand-900 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-950 disabled:opacity-50"
          title="Publish to the marketplace (a super_admin approves it)">
          {busy === 'submit' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Submit for approval
        </button>
      </div>

      <div className={`grid gap-4 ${testOpen ? 'lg:grid-cols-[210px_minmax(0,1fr)_400px]' : 'lg:grid-cols-[210px_minmax(0,1fr)]'}`}>
        <nav className="space-y-1 lg:sticky lg:top-20 lg:self-start">
          {SECTIONS.map((x) => (
            <button key={x.key} type="button" onClick={() => setSection(x.key)}
              className={`flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left transition ${section === x.key ? 'bg-brand-50 text-brand-900 ring-1 ring-brand-200' : 'text-slate-700 hover:bg-slate-100'}`}>
              <x.icon className={`mt-0.5 h-4 w-4 shrink-0 ${section === x.key ? 'text-brand-600' : 'text-slate-400'}`} />
              <span>
                <span className="block text-sm font-semibold">{x.label}{x.key === 'agents' ? ` (${crews.length})` : x.key === 'variables' && variables.length ? ` (${variables.length})` : x.key === 'tools' && localTools.length ? ` (${localTools.length})` : ''}</span>
                <span className="block text-xs leading-snug text-slate-500">{x.hint}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="min-w-0 space-y-4">
          {section === 'overview' && (<>
            {/* Info */}
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="font-semibold mb-3">Info</h2>
              <div className="grid sm:grid-cols-2 gap-3">
                <L label="Code (kebab-case)" hint="The profile's unique id, lowercase-with-dashes. Used internally, not shown to buyers."><input className={inp} value={code} onChange={(e) => setCode(e.target.value)} placeholder="my-agent" /></L>
                <L label="Display name" hint="The name people see in the marketplace and the chat picker."><input className={inp} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="My Agent" /></L>
                <L label="Version" hint="Bump it when you change the profile (e.g. 1.0.0 → 1.1.0)."><input className={inp} value={version} onChange={(e) => setVersion(e.target.value)} /></L>
                <L label="Category" hint="Where the agent is grouped in the marketplace."><select className={inp} value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}</select></L>
                <L label="Surface" hint="Where the agent runs: a chat persona users pick, a background batch (scheduled/triggered), or both."><select className={inp} value={surface} onChange={(e) => setSurface(e.target.value)} title="chat = persona selectable in the chat · background = CrewAI/Ray batch (schedule/trigger) · both">
                  <option value="background">⚙ background (batch)</option>
                  <option value="chat">💬 chat (persona)</option>
                  <option value="both">both</option>
                </select></L>
                <L label="Tags (comma-sep)" hint="Keywords to find the agent in the marketplace. Comma-separated."><input className={inp} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="etl, scraping" /></L>
                <L label="Required capabilities (comma-sep)" hint="Platform features the agent needs to run — e.g. webrobot_mcp (the WebRobot tools), postiz_mcp (social publishing). A buyer whose plan lacks them can't install it. Leave empty if none. Comma-separated."><input className={inp} value={requiredCaps} onChange={(e) => setRequiredCaps(e.target.value)} placeholder="webrobot_mcp, postiz_mcp" /></L>
              </div>
              <L label="Description" className="mt-3" hint="One or two sentences on what this agent does — shown to buyers in the marketplace."><textarea className={inp + ' h-20'} value={description} onChange={(e) => setDescription(e.target.value)} /></L>
            </section>

          </>)}
          {section === 'agents' && (<>
            {/* Crews */}
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold">Crews <span className="text-xs font-normal text-slate-400">({crews.length} {crews.length === 1 ? 'agent' : 'agents'})</span></h2>
                <div className="flex items-center gap-3">
                  {/* EXPLICIT structure selector (decoupled from crew count). */}
                  <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5 text-xs">
                    {(['single', 'team'] as const).map((m) => (
                      <button key={m} onClick={() => setMode(m)}
                        className={`rounded px-2.5 py-1 font-medium transition ${mode === m ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                        title={m === 'single' ? 'Independent agent(s) — 1 single, N = personas (chat picker), no DAG' : 'Agents collaborate via an orchestration DAG (chat_mode: team)'}>
                        {m === 'single' ? (crews.length > 1 ? 'Personas' : 'Single') : 'Team'}
                      </button>
                    ))}
                  </div>
                  <button onClick={addCrew} className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline"><Plus className="h-4 w-4" /> Add agent</button>
                </div>
              </div>
              <div className="space-y-4">
                {crews.map((c, i) => (
                  <div key={i} id={`crew-${c.id}`} className="scroll-mt-24 rounded-lg border border-slate-200 p-3">
                    <p className="mb-2 text-[11px] leading-snug text-slate-400">
                      <b className="font-medium text-slate-500">id</b> = short name of this agent ·
                      <b className="font-medium text-slate-500"> engine</b> = runtime (agent_sdk is the default tool-using agent) ·
                      <b className="font-medium text-slate-500"> model</b> = the LLM. The system prompt below is the agent's instructions; the MCP servers give it its tools.
                    </p>
                    <div className="flex items-center gap-2 mb-2">
                      <input className={inp + ' max-w-[140px]'} value={c.id} onChange={(e) => setCrew(i, { id: e.target.value })} placeholder="id" title="Short unique name for this agent (e.g. researcher)" />
                      <select className={inp + ' max-w-[130px]'} value={c.engine} title="Agent framework" onChange={(e) => { const en = e.target.value; const ok = (MODELS_BY_ENGINE[en] || []).some((m) => m.id === c.model); setCrew(i, ok ? { engine: en } : { engine: en, model: defaultModelFor(en) }); }}>{ENGINES.map((en) => <option key={en} value={en}>{en}</option>)}</select>
                      <select className={inp} value={c.model} title="Models this framework can run" onChange={(e) => setCrew(i, { model: e.target.value })}>
                        {(MODELS_BY_ENGINE[c.engine] || MODELS_BY_ENGINE.agent_sdk).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                        {!(MODELS_BY_ENGINE[c.engine] || []).some((m) => m.id === c.model) && <option value={c.model}>{c.model} (current, not in the list)</option>}
                      </select>
                      {crews.length > 1 && <button onClick={() => removeCrew(i)} className="text-slate-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>}
                    </div>
                    <textarea className={inp + ' h-16 mb-2'} value={c.system_prompt} onChange={(e) => setCrew(i, { system_prompt: e.target.value })} placeholder="system prompt (use {{variable}} to inject declared variables)" />
                    {/* Tools = MCP servers. One explicit list (user 10-23: "it is not clear how to add MCP
                        endpoints"): before, a single url box silently edited the FIRST server, the others
                        lived only in the YAML, and typing a url could overwrite an integration. */}
                    {(() => {
                      const servers = crewServers(c);
                      const setServers = (next: McpServer[]) => setCrew(i, { mcp: next });
                      const patchServer = (k: number, patch: Partial<McpServer>) => setServers(servers.map((m, j) => (j === k ? { ...m, ...patch } : m)));
                      const hasWebrobot = servers.some((m) => m.url === WEBROBOT_MCP.url);
                      const integOf = (m: McpServer) => mcpIntegrations.find((ig) => ig.mcpUrl === m.url);
                      const available = mcpIntegrations.filter((ig) => !servers.some((m) => m.url === ig.mcpUrl));
                      return (
                        <div className="mb-2 rounded-md border border-slate-200 bg-slate-50 p-2.5">
                          <div className="mb-1.5 flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-slate-700">Tools · MCP servers</span>
                            <span className="text-xs text-slate-500">each server gives the agent a set of tools</span>
                          </div>
                          {servers.length === 0 && <p className="mb-2 text-xs text-slate-500">No tools: the agent can only reason and write. Add a server below.</p>}
                          <div className="space-y-1.5">
                            {servers.map((m, k) => {
                              const ig = integOf(m);
                              const allowAll = !m.allow || m.allow === 'all';
                              const key = `${i}:${ig?.provider}`;
                              return (
                                <div key={k} className="rounded border border-slate-200 bg-white p-2">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <input className={inp + ' h-8 py-1 max-w-[130px] font-mono'} value={m.name} title="Short name: the tools appear to the agent as mcp__<name>__<tool>"
                                      onChange={(e) => patchServer(k, { name: e.target.value.replace(/[^a-zA-Z0-9_-]/g, '') })} placeholder="name" />
                                    <input className={inp + ' h-8 py-1 flex-1 min-w-[220px]'} value={m.url} onChange={(e) => patchServer(k, { url: e.target.value })} placeholder="https://… /mcp endpoint (streamable HTTP)" />
                                    <button type="button" onClick={() => setServers(servers.filter((_, j) => j !== k))} className="text-slate-400 hover:text-red-600" title="Remove this server"><Trash2 className="h-4 w-4" /></button>
                                  </div>
                                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                                    <label className="inline-flex items-center gap-1">
                                      <input type="checkbox" checked={allowAll} onChange={(e) => patchServer(k, { allow: e.target.checked ? 'all' : [] })} /> all its tools
                                    </label>
                                    {!allowAll && (
                                      <input className={inp + ' h-7 py-0.5 flex-1 min-w-[200px] text-xs'} value={Array.isArray(m.allow) ? m.allow.join(', ') : String(m.allow || '')}
                                        onChange={(e) => patchServer(k, { allow: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
                                        placeholder="only these tools, comma-separated (e.g. catalogSources, wizardValidate)" />
                                    )}
                                    {m.headers && Object.keys(m.headers).length > 0 && !ig && (
                                      <span className="rounded bg-slate-100 px-1.5 py-0.5">🔑 sends {Object.keys(m.headers).join(', ')}</span>
                                    )}
                                  </div>
                                  {ig && (
                                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                                      <span className="text-xs text-slate-600">🔑 {ig.label} API key</span>
                                      <input type="password" className={inp + ' h-8 py-1 max-w-[220px]'} placeholder={`${ig.provider} API key`}
                                        value={intgKey[key] || ''} onChange={(e) => setIntgKey((mm) => ({ ...mm, [key]: e.target.value }))} />
                                      <button type="button" onClick={() => saveIntegrationKey(i, ig)} disabled={!(intgKey[key] || '').trim()}
                                        className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50">Save key</button>
                                      <span className="text-[11px] text-slate-500">{intgMsg[key] || 'stored for your organization, never in the profile'}</span>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            {!hasWebrobot && (
                              <button type="button" onClick={() => setServers([...servers, { ...WEBROBOT_MCP }])}
                                className="inline-flex items-center gap-1 rounded-lg border border-brand-200 bg-white px-2.5 py-1 text-sm font-medium text-brand-800 hover:bg-brand-50">
                                <Plus className="h-4 w-4" /> WebRobot platform tools
                              </button>
                            )}
                            <button type="button" onClick={() => setServers([...servers, { name: `mcp${servers.length + 1}`, type: 'http', url: '', allow: 'all' }])}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50">
                              <Plus className="h-4 w-4" /> Custom MCP server
                            </button>
                            {available.length > 0 && (
                              <select className={inp + ' max-w-[240px] h-8 py-1'} value=""
                                onChange={(e) => { const ig = mcpIntegrations.find((x) => x.provider === e.target.value); if (ig) attachIntegration(i, c, ig); }}>
                                <option value="">+ Integration (needs a key)…</option>
                                {available.map((ig) => <option key={ig.provider} value={ig.provider}>{ig.label}</option>)}
                              </select>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                    {/* Runtime & safety — now editable in the form (previously YAML-only and silently dropped on edit). */}
                    <div className="grid sm:grid-cols-2 gap-2">
                      <L label="Permission mode" hint="How freely the agent acts (agent_sdk): default asks before sensitive actions; bypassPermissions runs unattended — use for background jobs."><select className={inp} value={c.permission_mode} onChange={(e) => setCrew(i, { permission_mode: e.target.value })}>{PERMISSION_MODES.map((p) => <option key={p} value={p}>{p || '(default)'}</option>)}</select></L>
                      <L label="Max turns" hint="Hard cap on reasoning/tool steps in one run — stops a runaway agent. e.g. 20–40."><input className={inp} type="number" min="1" value={c.max_turns} onChange={(e) => setCrew(i, { max_turns: e.target.value })} placeholder="e.g. 20" /></L>
                      <L label="Max budget (USD/turn)" hint="Spend ceiling per turn; the run stops if exceeded. Keeps costs bounded."><input className={inp} type="number" min="0" step="0.01" value={c.max_budget_usd} onChange={(e) => setCrew(i, { max_budget_usd: e.target.value })} placeholder="e.g. 0.50" /></L>
                      <L label="Disallowed tools (comma-sep)" hint="Tools this agent must NOT use, even if its MCP exposes them (e.g. Bash). A safety fence. Comma-separated."><input className={inp} value={c.disallowed_tools} onChange={(e) => setCrew(i, { disallowed_tools: e.target.value })} placeholder="e.g. Bash, mcp__camoufox__agentic_browse" /></L>
                    </div>
                  </div>
                ))}
              </div>
            </section>

          </>)}
          {section === 'team' && (<>
            {!isTeam && (
              <section className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
                <Network className="mx-auto h-8 w-8 text-brand-500" />
                <h2 className="mt-2 text-lg font-semibold text-slate-900">This is a single agent</h2>
                <p className="mx-auto mt-1 max-w-lg text-sm text-slate-600">
                  The graph shows how several agents work together — a chain of hand-offs, or a swarm sharing a workspace.
                  Make it a team to draw it{crews.length < 2 ? ', then add agents in the Agents section' : ''}.
                </p>
                <div className="mt-4 flex justify-center gap-2">
                  <button type="button" onClick={() => setMode('team')} className="rounded-lg bg-brand-900 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-950">Make it a team</button>
                  {crews.length < 2 && (
                    <button type="button" onClick={() => { setMode('team'); addCrew(); }} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Make it a team and add an agent</button>
                  )}
                </div>
              </section>
            )}
            {/* Orchestration (teams only) — edge editor + visual graph */}
            {isTeam && (
              <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-4 flex flex-wrap items-center gap-3">
                  <h2 className="font-semibold">How the team works</h2>
                  <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-sm">
                    {([['chain', 'Chain — hand-offs'], ['swarm', 'Swarm — shared workspace']] as const).map(([k, l]) => (
                      <button key={k} type="button" onClick={() => setTeamKind(k)}
                        className={`rounded-md px-3 py-1 font-medium ${teamKind === k ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{l}</button>
                    ))}
                  </div>
                </div>
                <p className="mb-4 text-sm text-slate-600">
                  {teamKind === 'chain'
                    ? 'Each agent works in turn and passes its result to the next — the arrows. Use it when the steps depend on each other.'
                    : 'Several agents work AT THE SAME TIME on one goal: they take tasks from a shared board, write what they find to a shared workspace and post new leads for the others. Use it for wide work (many sources, many items).'}
                </p>
                {teamKind === 'chain' ? (<>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="font-semibold">Team graph</h2>
                  <span className="flex items-center gap-3">
                    <span className="text-xs text-slate-500">{crews.length} agents · {edges.length} hand-offs · entry <b>{entry}</b></span>
                    <button type="button" onClick={addCrew}
                      className="inline-flex items-center gap-1 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-sm font-medium text-brand-800 hover:bg-brand-100">
                      <Plus className="h-4 w-4" /> Add agent
                    </button>
                  </span>
                </div>
                <OrchestrationGraph
                  crews={crews} entry={entry} edges={edges}
                  onConnectEdge={(from, to) => setEdges((es) => es.some((x) => x.from === from && x.to === to) ? es : [...es, { from, to }])}
                  onRemoveEdge={(from, to) => setEdges((es) => es.filter((x) => !(x.from === from && x.to === to)))}
                  onSetEntry={(id) => setEntry(id)}
                  onOpenAgent={openAgent}
                />
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm font-medium text-slate-600">Edit as a list</summary>
                  <div className="mt-3">
                <L label="Entry agent" className="max-w-xs mb-3">
                  <select className={inp} value={entry} onChange={(e) => setEntry(e.target.value)}>{crews.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}</select>
                </L>
                <div className="space-y-2 mb-4">
                  {edges.map((ed, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <select className={inp + ' max-w-[160px]'} value={ed.from} onChange={(e) => setEdges((es) => es.map((x, j) => j === i ? { ...x, from: e.target.value } : x))}>{crews.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}</select>
                      <span className="text-slate-400">→</span>
                      <select className={inp + ' max-w-[160px]'} value={ed.to} onChange={(e) => setEdges((es) => es.map((x, j) => j === i ? { ...x, to: e.target.value } : x))}>{crews.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}</select>
                      <button onClick={() => setEdges((es) => es.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  ))}
                  <button onClick={() => setEdges((es) => [...es, { from: crews[0]?.id, to: crews[crews.length - 1]?.id }])} className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline"><Plus className="h-4 w-4" /> Add edge</button>
                </div>
                  </div>
                </details>
                </>) : (
                  <div>
                    {/* The swarm as a group: members (×replicas) around the shared board/workspace, then the lead. */}
                    <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex-1 rounded-xl border-2 border-dashed border-brand-300 bg-white p-3">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-700">Swarm · shared workspace + task board</p>
                        <div className="flex flex-wrap gap-2">
                          {crews.filter((c) => c.id !== swarmLead).map((c) => (
                            <div key={c.id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 shadow-sm">
                              <button type="button" onClick={() => openAgent(c.id)} className="font-mono text-sm font-semibold text-slate-900 hover:underline">{c.id}</button>
                              <span className="text-xs text-slate-500">×</span>
                              <input type="number" min={1} max={20} value={swarmReplicas[c.id] || 1}
                                onChange={(e) => setSwarmReplicas((r) => ({ ...r, [c.id]: Math.max(1, Math.min(20, Number(e.target.value) || 1)) }))}
                                title="How many copies of this agent work in parallel"
                                className="w-14 rounded border border-slate-200 px-1.5 py-0.5 text-sm" />
                            </div>
                          ))}
                          <button type="button" onClick={addCrew} title="Add a member to the swarm"
                            className="inline-flex items-center gap-1 rounded-lg border border-dashed border-brand-300 bg-white px-2.5 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-50">
                            <Plus className="h-4 w-4" /> Add agent
                          </button>
                        </div>
                      </div>
                      <span className="text-2xl text-slate-300" aria-hidden="true">→</span>
                      <div className="rounded-xl border border-slate-200 bg-white p-3">
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Lead (optional)</p>
                        <select className={inp + ' max-w-[200px]'} value={swarmLead} onChange={(e) => setSwarmLead(e.target.value)}
                          title="Reads the whole workspace at the end and writes the team's answer">
                          <option value="">— none: the workspace summary —</option>
                          {crews.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_180px]">
                      <L label="First tasks on the board (one per line)" hint="What the swarm starts from — e.g. one line per source or per item. {goal} and the run inputs can be used. Empty = the run's goal as a single task; the agents post new tasks as they find leads.">
                        <textarea className={inp + ' h-28 font-mono text-xs'} value={seedTasks} onChange={(e) => setSeedTasks(e.target.value)} placeholder={'Collect the reviews of {goal} on site A\nCollect the reviews of {goal} on site B'} />
                      </L>
                      <L label="Time limit (minutes)" hint="The swarm stops when the board is empty and everyone is idle, or at this limit.">
                        <input type="number" min={1} className={inp} value={swarmMaxMin} onChange={(e) => setSwarmMaxMin(e.target.value)} />
                      </L>
                    </div>
                    <p className="mt-3 text-xs text-slate-500">Members need the agent_sdk engine. Total parallel agents: {crews.filter((c) => c.id !== swarmLead).reduce((n, c) => n + (swarmReplicas[c.id] || 1), 0)}.</p>
                  </div>
                )}
              </section>
            )}

          </>)}
          {section === 'tools' && (<>
            {/* Inline local tools */}
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between mb-1">
                <h2 className="font-semibold flex items-center gap-2"><Wrench className="h-4 w-4 text-brand-600" /> Local tools <span className="text-xs font-normal text-slate-400">(inline, no rebuild)</span></h2>
                <button onClick={addTool} className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline"><Plus className="h-4 w-4" /> Add tool</button>
              </div>
              <p className="text-xs text-slate-500 mb-3">Python function bodies compiled into in-process tools (the agentic analog of ETL python_extensions). Receive <code>args</code> (dict), <code>return</code> a JSON-serializable result. Works for both agent_sdk and crewai. <span className="text-amber-700">Trusted authors only until the sandbox lands.</span></p>
              <div className="space-y-3">
                {localTools.map((t, i) => (
                  <div key={i} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <input className={inp + ' max-w-[180px]'} value={t.name} onChange={(e) => setTool(i, { name: e.target.value })} placeholder="tool name" />
                      <input className={inp} value={t.description} onChange={(e) => setTool(i, { description: e.target.value })} placeholder="description" />
                      <button onClick={() => removeTool(i)} className="text-slate-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                    </div>
                    <textarea className={inp + ' h-24 font-mono text-xs'} value={t.code} onChange={(e) => setTool(i, { code: e.target.value })} placeholder={'import os, json, urllib.request\nreturn {"ok": True}'} />
                  </div>
                ))}
                {!localTools.length && <p className="text-xs text-slate-400">No inline tools. The agent can still use MCP servers above.</p>}
              </div>
            </section>

          </>)}
          {section === 'variables' && (<>
            {/* Variables — the clone-wizard knobs */}
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between mb-1">
                <h2 className="font-semibold flex items-center gap-2"><Variable className="h-4 w-4 text-brand-600" /> Variables</h2>
                <button onClick={addVar} className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline"><Plus className="h-4 w-4" /> Add variable</button>
              </div>
              <p className="text-xs text-slate-500 mb-3">Configurable knobs the clone wizard renders. <b>bind</b>: <code>prompt</code> = {'{{name}}'} in the system prompt · <code>env</code> = read by local tools via <code>os.getenv</code> · <code>both</code>. Mark <b>secret</b> + set a <b>provider</b> to require a cloud credential (key resolved server-side, never stored).</p>
              <div className="space-y-3">
                {variables.map((v, i) => (
                  <div key={i} className="rounded-lg border border-slate-200 p-3 grid sm:grid-cols-2 gap-2">
                    <input className={inp} value={v.name} onChange={(e) => setVar(i, { name: e.target.value })} placeholder="name (e.g. basket)" />
                    <input className={inp} value={v.label} onChange={(e) => setVar(i, { label: e.target.value })} placeholder="label" />
                    <input className={inp} value={v.default} onChange={(e) => setVar(i, { default: e.target.value })} placeholder="default" disabled={v.secret} />
                    <div className="flex items-center gap-2">
                      <select className={inp + ' max-w-[110px]'} value={v.bind} onChange={(e) => setVar(i, { bind: e.target.value })} disabled={v.secret}>{BINDS.map((b) => <option key={b} value={b}>{b}</option>)}</select>
                      <label className="flex items-center gap-1 text-xs text-slate-600 whitespace-nowrap"><input type="checkbox" checked={v.secret} onChange={(e) => setVar(i, { secret: e.target.checked })} /> secret</label>
                      <button onClick={() => removeVar(i)} className="ml-auto text-slate-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                    </div>
                    {v.secret && <input className={inp} value={v.provider} onChange={(e) => setVar(i, { provider: e.target.value })} placeholder="credential provider (e.g. postiz, binance)" />}
                    <input className={inp} value={v.description} onChange={(e) => setVar(i, { description: e.target.value })} placeholder="description (shown in the wizard)" />
                  </div>
                ))}
                {!variables.length && <p className="text-xs text-slate-400">No variables — the clone is fixed. Add some to make it configurable.</p>}
              </div>
            </section>

          </>)}
          {section === 'trading' && (<>
            {/* Trading — bind the strategy-agent to a market (increment 1) */}
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between mb-1">
                <h2 className="font-semibold flex items-center gap-2">📈 Trading</h2>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={tradingEnabled} onChange={(e) => setTradingEnabled(e.target.checked)} /> Trading bot
                </label>
              </div>
              <p className="text-xs text-slate-500 mb-3">The strategy stays an agent; these fields bind it to a market. The agent sets the weights on the <b>asset universe</b> — the Nautilus node converges to them.</p>
              {tradingEnabled && (
                <div className="space-y-3">
                  <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5 text-xs">
                    {TRADING_MODES.map((m) => (
                      <button key={m.v} onClick={() => setTradingMode(m.v)}
                        className={`rounded px-2.5 py-1 font-medium transition ${tradingMode === m.v ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <L label="Tenant (org id) — empty = your org">
                      <input className={inp} value={tradingOrgId} onChange={(e) => setTradingOrgId(e.target.value)} placeholder="super_admin: e.g. 5 (Screebits)" />
                    </L>
                    <div className="flex items-end text-[11px] pb-1">
                      {allowedErr ? <span className="text-amber-700">{allowedErr}</span>
                        : allowed && !allowed.enabled ? <span className="text-amber-700">Live trading is NOT enabled for this org — enable it in /dashboard/trading/limits.</span>
                        : allowed ? <span className="text-emerald-700">✓ Trading enabled · {allowed.instruments.length} allowed instruments</span>
                        : <span className="text-slate-400">loading allowed assets…</span>}
                    </div>
                  </div>
                  <L label="Asset universe — the strategy monitors and allocates across these (select from the allow-list)">
                    {allowed && allowed.instruments.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {allowed.instruments.map((sym) => {
                          const on = universeSet.includes(sym);
                          return (
                            <button key={sym} type="button" onClick={() => toggleSym(sym)}
                              className={`rounded-md border px-2.5 py-1 text-xs font-mono ${on ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                              {on ? '✓ ' : ''}{sym}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <input className={inp} value={universe} onChange={(e) => setUniverse(e.target.value)} placeholder="BTCUSDT.BINANCE, ETHUSDT.BINANCE" />
                    )}
                  </L>
                  <div className="grid sm:grid-cols-3 gap-3">
                    <L label="Venue"><select className={inp} value={venue} onChange={(e) => setVenue(e.target.value)}>{(allowed && allowed.venues.length ? allowed.venues : VENUES).map((v) => <option key={v}>{v}</option>)}</select></L>
                    <L label="Bar interval"><select className={inp} value={barInterval} onChange={(e) => setBarInterval(e.target.value)}>{BAR_INTERVALS.map((b) => <option key={b}>{b}</option>)}</select></L>
                    <L label="Exchange credentials"><input className={inp} value={tradingCredential} onChange={(e) => setTradingCredential(e.target.value)} placeholder="cloud_credential name" /></L>
                  </div>
                  <div className="grid sm:grid-cols-3 gap-3">
                    <L label="Max exposure %"><input type="number" className={inp} value={maxExposurePct} onChange={(e) => setMaxExposurePct(e.target.value)} /></L>
                    <L label="Max drawdown % (constraint)"><input type="number" className={inp} value={maxDrawdownPct} onChange={(e) => setMaxDrawdownPct(e.target.value)} /></L>
                    <L label="Kill-switch"><span className="inline-flex items-center gap-2 text-sm h-9"><input type="checkbox" checked={killSwitch} onChange={(e) => setKillSwitch(e.target.checked)} /> enabled</span></L>
                  </div>
                  <p className="text-[11px] text-amber-700">⚠ Credentials must belong to the <b>end customer</b>, not fall back to the tenant. The guardrails (trading enabled, cap, allow-list) are enforced by the server.</p>
                  <div className="flex items-center gap-3 pt-1">
                    <button onClick={deployBot} disabled={busy === 'deploy' || !universe.trim()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                      {busy === 'deploy' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Deploy bot
                    </button>
                    <span className="text-[11px] text-slate-500">Registers the strategy (kind: agentic) and starts the bot. A super_admin must act on behalf of a tenant.</span>
                  </div>
                </div>
              )}
            </section>

          </>)}
          {section === 'marketplace' && (<>
            {/* Pricing */}
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="font-semibold flex items-center gap-2 mb-3"><Tag className="h-4 w-4 text-brand-600" /> Pricing</h2>
              <div className="grid sm:grid-cols-3 gap-3 items-end">
                <L label="Price model" hint="How buyers pay: free, one-off, per run, or monthly subscription."><select className={inp} value={priceUnit} onChange={(e) => setPriceUnit(e.target.value)}>{PRICE_UNITS.map((u) => <option key={u} value={u}>{u.replace(/_/g, ' ')}</option>)}</select></L>
                <L label="Price (€)" hint="What the buyer pays, in euro. Disabled when the model is free."><input className={inp} type="number" min="0" step="0.01" value={priceEur} onChange={(e) => setPriceEur(e.target.value)} disabled={priceUnit === 'free'} /></L>
                <L label="Revenue share to you (%)" hint="Your cut of each sale; the platform keeps the rest."><input className={inp} type="number" min="0" max="100" value={revenueShare} onChange={(e) => setRevenueShare(e.target.value)} disabled={priceUnit === 'free'} /></L>
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={isPaid ? true : locked} disabled={isPaid} onChange={(e) => setLocked(e.target.checked)} />
                Locked clone (spec hidden; buyers configure variables only){isPaid && <span className="text-xs text-slate-400">— forced on for paid listings</span>}
              </label>
              <p className="text-xs text-slate-500 mt-1">Price is stored in cents (€{Number(priceEur || '0').toFixed(2)} → {Math.round(Number(priceEur || '0') * 100)} cents). Free + referenceable when €0.</p>
            </section>

          </>)}
          {section === 'definition' && (<>
            {/* spec preview + actions */}
            <details open className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <summary className="cursor-pointer font-semibold text-sm">agent_definition (preview)</summary>
              <pre className="text-xs bg-slate-50 border rounded p-3 mt-3 overflow-auto max-h-72">{JSON.stringify(agentDefinition, null, 2)}</pre>
            </details>

          </>)}
        </div>

        {testOpen && <div className="lg:sticky lg:top-20 lg:self-start lg:h-[calc(100vh-7rem)]"><TestPanel profileId={savedId != null ? String(savedId) : null} dirty={dirty} /></div>}
      </div>
    </div>
  );
}

export default function AgentStudio(props: AgentStudioProps) {
  return <AgentStudioInner {...props} />;
}

const inp = 'w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:ring-1 focus:ring-brand-200 outline-none';
function L({ label, children, className = '', hint }: { label: string; children: ReactNode; className?: string; hint?: string }) {
  // `hint`: una riga muta sotto l'etichetta che spiega COS'E' il campo. Il form ha molti termini
  // tecnici (Required capabilities, Disallowed tools, Surface, Permission mode) su cui il nuovo
  // utente si blocca: l'aiuto in linea li scioglie senza mandarlo altrove.
  return (
    <label className={`block ${className}`}>
      <span className="text-xs font-medium text-slate-700">{label}</span>
      {hint && <span className="mt-0.5 block text-[11px] leading-snug text-slate-400">{hint}</span>}
      <div className="mt-1">{children}</div>
    </label>
  );
}
