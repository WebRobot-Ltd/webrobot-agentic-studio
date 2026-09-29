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
import { Bot, Plus, Trash2, Loader2, Save, Send, Users, Variable, Wrench, Tag, Sparkles } from 'lucide-react';
import { ReactFlow, Background, Controls, type Node, type Edge as FlowEdge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  getAgenticProfile, saveAgenticProfile, publishAgenticProfile,
  allowedAssets, registerStrategy, deployBot as deployBotCall,
  startAgentDesignerRun, getAgentRunStatus, getAgentRunResult,
  extractAgentDefinition, extractAgentNeeds, AgentStudioError,
  getMcpIntegrations, mcpAuthHeader, saveMcpCredential, type McpIntegration,
  getAgentProfileDraft, deleteAgentProfileDraft,
} from '../client';

// Contesto del canale draft, uguale al pageContext che DesignWithChat inietta nella chat.
const DRAFT_CTX = 'agentic:agent-studio';

const CATEGORIES = [
  'data_engineer', 'scraping_agent', 'research_agent', 'monitoring_agent',
  'social_distribution', 'support_agent', 'rag_assistant', 'analytics_agent',
  'finance', 'multi_agent_team', 'other',
];

// Il run del progettista e' un RayJob ASINCRONO (decine di secondi): puo' superare l'attesa inline
// o l'utente puo' chiudere/navigare via. Si ricorda l'executionId in localStorage e lo si riprende
// al montaggio — sia in corso, sia gia' finito. Tutto in try/catch: senza storage si prosegue senza
// ripresa. Chiave per sessione (editId o "new") per non applicare un run di un profilo a un altro.
const RUN_KEY = (ctx: string) => `wr_agent_designer_run:${ctx}`;
const RUN_MAX_AGE_MS = 30 * 60 * 1000;
interface RunSalvato { executionId: string; prompt: string; startedAt: number; }
function leggiRun(ctx: string): RunSalvato | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(RUN_KEY(ctx)) : null;
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v.executionId === 'string' ? (v as RunSalvato) : null;
  } catch { return null; }
}
function salvaRun(ctx: string, v: RunSalvato): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(RUN_KEY(ctx), JSON.stringify(v)); } catch { /* private/quota */ }
}
function scartaRun(ctx: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(RUN_KEY(ctx)); } catch { /* ignore */ }
}
const ENGINES = ['agent_sdk', 'crewai', 'autogen'];
const PRICE_UNITS = ['free', 'flat', 'subscription_monthly', 'subscription_yearly'];
const BINDS = ['env', 'prompt', 'both'];
// Trading layer (increment 1): a strategy is an AGENT; these fields make it a trading bot.
// Both output modes are agentic — portfolio (fixes target weights, node converges) is the
// validated path; orders (emits orders/signals directly) is the less-mature signal mode.
const TRADING_MODES = [
  { v: 'portfolio', label: 'Portafoglio · pesi (validato)' },
  { v: 'orders', label: 'Ordini · signal (sperimentale)' },
];
// Venue in MAIUSCOLO come la allow-list di organizations.trading_limits (es. Screebits: ["BINANCE"]).
const VENUES = ['BINANCE', 'BINANCE_TESTNET', 'BYBIT', 'BYBIT_TESTNET'];
const BAR_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];

interface Crew {
  id: string;
  engine: string;
  model: string;
  system_prompt: string;
  mcp_url: string; // optional single MCP (allow:all); '' = none
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
function OrchestrationGraph({ crews, entry, edges }: { crews: Crew[]; entry: string; edges: Edge[] }) {
  const nodes: Node[] = crews.map((c, i) => ({
    id: c.id || `n${i}`,
    position: { x: (i % 3) * 220, y: Math.floor(i / 3) * 130 },
    data: { label: `${c.id}${c.id === entry ? '  ▶ entry' : ''}  ·  ${c.engine}` },
    style: {
      border: c.id === entry ? '2px solid #7c3aed' : '1px solid #cbd5e1',
      borderRadius: 8, padding: 8, fontSize: 12, background: '#fff', width: 180,
    },
  }));
  const fedges: FlowEdge[] = edges
    .filter((x) => x.from && x.to)
    .map((x, i) => ({ id: `e${i}`, source: x.from, target: x.to, animated: true }));
  return (
    <div style={{ height: 300 }} className="rounded-lg border border-slate-200 bg-slate-50">
      <ReactFlow nodes={nodes} edges={fedges} fitView nodesDraggable nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}>
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function AgentStudioInner({ chatSlot, editId = null, onSaved, onDeployed }: AgentStudioProps) {
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('data_engineer');
  const [tags, setTags] = useState('');
  const [crews, setCrews] = useState<Crew[]>([
    { id: 'agent', engine: 'agent_sdk', model: 'claude-sonnet-4-5', system_prompt: 'You are a helpful WebRobot agent.', mcp_url: 'https://mcp.webrobot.eu/mcp', permission_mode: '', disallowed_tools: '', max_turns: '', max_budget_usd: '' },
  ]);
  const [entry, setEntry] = useState('agent');
  const [edges, setEdges] = useState<Edge[]>([]);
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
    if (meta?.id != null) setSavedId(Number(meta.id));
    if (meta?.status) setStatus(meta.status);
    if (meta?.surface) setSurface(meta.surface);
    setMode(def.chat_mode === 'team' ? 'team' : 'single');
    setCode(def.profile || meta?.name || '');
    setDisplayName(meta?.name || def.display_name || def.profile || '');
    setVersion(meta?.version || def.version || '1.0.0');
    setDescription(meta?.description || def.description || '');
    const cs: Crew[] = (def.crews || []).map((c: any) => ({
      id: c.id || 'agent', engine: c.engine || 'agent_sdk', model: c.model || 'claude-sonnet-4-5',
      system_prompt: c.system_prompt || '', mcp_url: (c.mcp_servers?.[0]?.url) || '',
      permission_mode: c.permission_mode || '',
      disallowed_tools: Array.isArray(c.disallowed_tools) ? c.disallowed_tools.join(', ') : (c.disallowed_tools || ''),
      max_turns: c.max_turns != null ? String(c.max_turns) : '',
      max_budget_usd: c.max_budget_usd != null ? String(c.max_budget_usd) : '',
      _raw: c,   // preserve every field (auth, goal_template, multi-server mcp, …) for round-trip
    }));
    if (cs.length) setCrews(cs);
    setEntry(def.orchestration?.entry || cs[0]?.id || 'agent');
    setEdges(def.orchestration?.edges || []);
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
        out.id = c.id; out.engine = c.engine; out.model = c.model; out.system_prompt = c.system_prompt;
        // MCP: the single url edits the FIRST server; extra servers from the
        // original are kept. Empty url + no original servers → no mcp_servers.
        // Empty url WITH original servers → keep them (manage multi-server in YAML mode).
        const rawMcp = Array.isArray(c._raw?.mcp_servers) ? c._raw.mcp_servers : [];
        if (c.mcp_url) {
          out.mcp_servers = rawMcp.length
            ? [{ ...rawMcp[0], url: c.mcp_url }, ...rawMcp.slice(1)]
            : [{ name: 'mcp', type: 'http', url: c.mcp_url, allow: 'all' }];
        } else if (rawMcp.length) { out.mcp_servers = rawMcp; } else { delete out.mcp_servers; }
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
      def.orchestration = {
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
  }, [code, crews, isTeam, entry, edges, declaredVars, declaredTools,
      tradingEnabled, tradingMode, venue, universe, barInterval, tradingCredential,
      maxExposurePct, maxDrawdownPct, killSwitch]);

  // ── "Descrivi il team -> l'agente lo progetta" ────────────────────────────────
  // Speculare a askForPipeline del pipeline designer: si avvia `webrobot-agent-designer`, se ne fa
  // polling, se ne legge il result (l'agent_definition), lo si MOSTRA come proposta; l'utente la
  // applica al form (applySpec) o la scarta. Il run e' di background: sopravvive a timeout/chiusura.

  // Segue un run fino all'esito e ne propone il risultato. Condiviso fra avvio inline e ripresa su
  // mount. Controlla lo stato PRIMA di dormire, cosi' un run gia' finito si propone subito.
  const seguiRun = useCallback(async (eid: string) => {
    setGenerating(true); setAskErr(null); setAskPhase('The designer agent is working…');
    try {
      const scadenza = Date.now() + 4 * 60 * 1000;   // attesa inline; oltre, resta salvato e si riprende
      let stato = '';
      while (Date.now() < scadenza) {
        const st = await getAgentRunStatus(eid).catch(() => null);
        stato = String(st?.persistedStatus || st?.status || '');
        if (['COMPLETED', 'FAILED', 'STOPPED'].includes(stato)) break;
        setAskPhase(`The designer agent is working… (${stato.toLowerCase() || 'running'})`);
        await new Promise((r) => setTimeout(r, 5000));
      }
      if (stato !== 'COMPLETED') {
        if (stato === 'FAILED' || stato === 'STOPPED') { setAskErr(`The agent run ended as ${stato}.`); scartaRun(runCtx); }
        else setAskErr('The agent is taking a while — you can leave this page; the proposal will appear here when it finishes.');
        return;
      }
      const result = await getAgentRunResult(eid);
      const def = extractAgentDefinition(result);
      scartaRun(runCtx);
      if (!def) {
        const needs = extractAgentNeeds(result);
        setAskErr(needs
          ? `The agent needs more detail: ${needs}`
          : 'The agent finished without a usable profile — try describing the agent and what it should do more concretely.');
        return;
      }
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
      setSavedId(id); setStatus('draft');
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
    if (!syms.length) { setMsg({ kind: 'err', text: 'Definisci almeno un asset nell’universo.' }); return; }
    if (!venue) { setMsg({ kind: 'err', text: 'Scegli un venue.' }); return; }
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
      if (!strategyId) throw new Error('strategyId non restituito dal registro strategie');
      // 2) avvia il bot (universo → instruments per il portfolio manager; singolo → instrument)
      const deployBody: Record<string, unknown> = { strategyId, venue, mode: tradingMode };
      if (tradingMode === 'portfolio') deployBody.instruments = syms.join(',');
      else deployBody.instrument = syms[0];
      await deployBotCall(deployBody, tradingOrgId.trim() || undefined);
      setMsg({ kind: 'ok', text: `Bot avviato (strategyId ${strategyId}). Lo trovi in Trading.` });
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
  const crewServers = (c: Crew): any[] => (Array.isArray((c as any)._raw?.mcp_servers) ? (c as any)._raw.mcp_servers : []);
  const attachIntegration = (i: number, c: Crew, integ: McpIntegration) => {
    const servers = [...crewServers(c)];
    if (!servers.some((s) => s?.url === integ.mcpUrl)) {
      servers.push({ name: integ.provider, type: 'http', url: integ.mcpUrl, allow: 'all', headers: mcpAuthHeader(integ) });
    }
    setCrew(i, { _raw: { ...((c as any)._raw || {}), mcp_servers: servers } } as Partial<Crew>);
  };
  const detachIntegration = (i: number, c: Crew, integ: McpIntegration) => {
    const servers = crewServers(c).filter((s) => s?.url !== integ.mcpUrl);
    setCrew(i, { _raw: { ...((c as any)._raw || {}), mcp_servers: servers } } as Partial<Crew>);
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
  const addCrew = () => setCrews((cs) => [...cs, { id: `agent${cs.length + 1}`, engine: 'agent_sdk', model: 'claude-sonnet-4-5', system_prompt: '', mcp_url: '', permission_mode: '', disallowed_tools: '', max_turns: '', max_budget_usd: '' }]);
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
    <div className="max-w-4xl mx-auto px-2 py-6 text-slate-900">
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-brand-600 via-violet-600 to-indigo-700 px-6 py-7 text-white shadow-lg mb-6">
        <div className="absolute -right-6 -top-6 opacity-15"><Bot className="h-40 w-40" /></div>
        <div className="relative">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="rounded-lg bg-white/15 p-2 backdrop-blur"><Bot className="h-6 w-6" /></div>
            <h1 className="text-2xl font-semibold tracking-tight">Agent Studio</h1>
            {isTeam && <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-xs"><Users className="h-3 w-3" /> Team</span>}
            <span className="ml-auto text-xs text-white/80">status: <b className="text-white">{status}</b>{savedId ? ` · id ${savedId}` : ''}</span>
          </div>
          <p className="mt-2 text-sm text-white/85 max-w-2xl">Compose an agent profile or a persistent multi-agent team — engines, prompts, declared variables, inline tools, orchestration and pricing — then publish to the marketplace (draft → submit → admin approval).</p>
        </div>
      </div>

      {/* Le due VIE FACILI — descrivere in una riga (l'agente progetta e propone) o conversare —
          erano assenti/sepolte: il nuovo utente atterrava su un form tecnico da "Code (kebab-case)".
          Qui in CIMA: la riga "Propose" avvia il progettista agentico (webrobot-agent-designer),
          come il pipeline designer; il chatSlot resta l'alternativa conversazionale, reso una sola
          volta (tolto dal fondo). Per un profilo nuovo la cornice nomina le vie; in modifica e' piu'
          leggera. Solo nel designer pieno (non embedded, dove l'host possiede il form). */}
      {(
        <div className="mb-5 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
          <p className="text-sm text-indigo-900">
            {editId
              ? 'Describe a change and the assistant redesigns this agent — or edit the form below.'
              : 'Start here: describe the agent — or the team — you want and the assistant designs it for you, ready to review and tweak below. Prefer to build it by hand? Fill in the form.'}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex flex-1 items-center gap-2">
              <input
                className="flex-1 rounded-md border border-indigo-200 px-3 py-2 text-sm"
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
                className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                title="Design an agent from this description — you review it before anything changes"
              >
                {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {generating ? 'Designing…' : 'Propose'}
              </button>
            </div>
            {chatSlot && <div className="shrink-0">{chatSlot}</div>}
          </div>
          {askPhase && !askErr && <p className="mt-2 text-xs text-indigo-700">{askPhase}</p>}
          {askErr && <p className="mt-2 text-xs text-rose-600">{askErr}</p>}
        </div>
      )}

      {/* La proposta dell'agente progettista: non applicata da sola, si vede e si decide. */}
      {proposal && (
        <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-emerald-900">
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
              className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700">
              Apply to the form
            </button>
            <button type="button" onClick={discardProposal}
              className="rounded-md px-2.5 py-1 text-xs text-slate-500 hover:bg-white">
              Discard
            </button>
          </div>
          {proposal.description && <p className="mt-1 text-xs text-emerald-800">{proposal.description}</p>}
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-emerald-700">See the proposed definition</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-emerald-200 bg-white p-2 text-[11px] leading-snug">{JSON.stringify(proposal, null, 2)}</pre>
          </details>
        </div>
      )}

      {msg && (
        <div className={`mb-4 rounded-lg border p-3 text-sm ${msg.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>{msg.text}</div>
      )}

      {/* Info */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 mb-5 shadow-sm">
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

      {/* Crews */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 mb-5 shadow-sm">
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
            <div key={i} className="rounded-lg border border-slate-200 p-3">
              <p className="mb-2 text-[11px] leading-snug text-slate-400">
                <b className="font-medium text-slate-500">id</b> = short name of this agent ·
                <b className="font-medium text-slate-500"> engine</b> = runtime (agent_sdk is the default tool-using agent) ·
                <b className="font-medium text-slate-500"> model</b> = the LLM. The system prompt below is the agent's instructions; the MCP url gives it a toolset.
              </p>
              <div className="flex items-center gap-2 mb-2">
                <input className={inp + ' max-w-[140px]'} value={c.id} onChange={(e) => setCrew(i, { id: e.target.value })} placeholder="id" title="Short unique name for this agent (e.g. researcher)" />
                <select className={inp + ' max-w-[130px]'} value={c.engine} onChange={(e) => setCrew(i, { engine: e.target.value })}>{ENGINES.map((en) => <option key={en} value={en}>{en}</option>)}</select>
                <input className={inp} value={c.model} onChange={(e) => setCrew(i, { model: e.target.value })} placeholder="model" />
                {crews.length > 1 && <button onClick={() => removeCrew(i)} className="text-slate-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>}
              </div>
              <textarea className={inp + ' h-16 mb-2'} value={c.system_prompt} onChange={(e) => setCrew(i, { system_prompt: e.target.value })} placeholder="system prompt (use {{variable}} to inject declared variables)" />
              <input className={inp + ' mb-2'} value={c.mcp_url} onChange={(e) => setCrew(i, { mcp_url: e.target.value })} placeholder="MCP url (optional, e.g. https://mcp.webrobot.eu/mcp)" />

              {/* MCP integrati (con credenziali). Il webrobot full MCP sopra non chiede chiavi; questi
                  SI (Postiz, ...). La chiave si salva in cloud_credentials (per org), l'header riferisce
                  solo ${'${PROVIDER_API_KEY}'} — il segreto non entra mai nel profilo. */}
              {mcpIntegrations.length > 0 && (() => {
                const attached = mcpIntegrations.filter((ig) => crewServers(c).some((s) => s?.url === ig.mcpUrl));
                const available = mcpIntegrations.filter((ig) => !attached.some((a) => a.provider === ig.provider));
                return (
                  <div className="mb-2 rounded-md border border-slate-200 bg-slate-50 p-2">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-xs font-medium text-slate-600">Integration MCPs (with credentials)</span>
                      {available.length > 0 && (
                        <select
                          className={inp + ' max-w-[220px] h-8 py-1'}
                          value=""
                          onChange={(e) => { const ig = mcpIntegrations.find((x) => x.provider === e.target.value); if (ig) attachIntegration(i, c, ig); }}
                        >
                          <option value="">+ add an integration…</option>
                          {available.map((ig) => <option key={ig.provider} value={ig.provider}>{ig.label}</option>)}
                        </select>
                      )}
                    </div>
                    {attached.length === 0 && (
                      <p className="text-[11px] leading-snug text-slate-400">
                        External MCPs that need a key (e.g. Postiz). Add one, paste its API key, and Save —
                        the key is stored securely for your organization, never in the profile.
                      </p>
                    )}
                    {attached.map((ig) => {
                      const k = `${i}:${ig.provider}`;
                      return (
                        <div key={ig.provider} className="mt-1 flex flex-wrap items-center gap-2 rounded border border-slate-200 bg-white p-2">
                          <span className="text-xs font-medium text-slate-700">{ig.label}</span>
                          <code className="rounded bg-slate-100 px-1 text-[10px] text-slate-500">${'{'}{ig.apiKeyEnv}{'}'}</code>
                          <input
                            type="password"
                            className={inp + ' h-8 py-1 max-w-[220px]'}
                            placeholder={`${ig.provider} API key`}
                            value={intgKey[k] || ''}
                            onChange={(e) => setIntgKey((m) => ({ ...m, [k]: e.target.value }))}
                          />
                          <button
                            type="button"
                            onClick={() => saveIntegrationKey(i, ig)}
                            disabled={!(intgKey[k] || '').trim()}
                            className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                          >
                            Save key
                          </button>
                          <button type="button" onClick={() => detachIntegration(i, c, ig)} className="text-slate-400 hover:text-red-600" title="Remove this integration"><Trash2 className="h-4 w-4" /></button>
                          {intgMsg[k] && <span className="text-[11px] text-slate-500">{intgMsg[k]}</span>}
                        </div>
                      );
                    })}
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

      {/* Trading — bind the strategy-agent to a market (increment 1) */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 mb-5 shadow-sm">
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-semibold flex items-center gap-2">📈 Trading</h2>
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={tradingEnabled} onChange={(e) => setTradingEnabled(e.target.checked)} /> Bot di trading
          </label>
        </div>
        <p className="text-xs text-slate-500 mb-3">La strategia resta un agente; questi campi la legano a un mercato. L&apos;agente fissa i pesi sull&apos;<b>universo di asset</b> — il nodo Nautilus converge.</p>
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
              <L label="Tenant (org id) — vuoto = la tua org">
                <input className={inp} value={tradingOrgId} onChange={(e) => setTradingOrgId(e.target.value)} placeholder="super_admin: es. 5 (Screebits)" />
              </L>
              <div className="flex items-end text-[11px] pb-1">
                {allowedErr ? <span className="text-amber-700">{allowedErr}</span>
                  : allowed && !allowed.enabled ? <span className="text-amber-700">Trading dal vivo NON abilitato per questa org — abilitalo in /dashboard/trading/limits.</span>
                  : allowed ? <span className="text-emerald-700">✓ Trading abilitato · {allowed.instruments.length} strumenti consentiti</span>
                  : <span className="text-slate-400">carico gli asset consentiti…</span>}
              </div>
            </div>
            <L label="Universo di asset — la strategia sorveglia e alloca su questi (seleziona dalla allow-list)">
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
              <L label="Credenziali exchange"><input className={inp} value={tradingCredential} onChange={(e) => setTradingCredential(e.target.value)} placeholder="nome cloud_credential" /></L>
            </div>
            <div className="grid sm:grid-cols-3 gap-3">
              <L label="Max esposizione %"><input type="number" className={inp} value={maxExposurePct} onChange={(e) => setMaxExposurePct(e.target.value)} /></L>
              <L label="Max drawdown % (vincolo)"><input type="number" className={inp} value={maxDrawdownPct} onChange={(e) => setMaxDrawdownPct(e.target.value)} /></L>
              <L label="Kill-switch"><span className="inline-flex items-center gap-2 text-sm h-9"><input type="checkbox" checked={killSwitch} onChange={(e) => setKillSwitch(e.target.checked)} /> attivo</span></L>
            </div>
            <p className="text-[11px] text-amber-700">⚠ Le credenziali devono essere del <b>cliente finale</b>, non ricadere sul tenant. I guardrail (trading abilitato, tetto, allow-list) li applica il server.</p>
            <div className="flex items-center gap-3 pt-1">
              <button onClick={deployBot} disabled={busy === 'deploy' || !universe.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                {busy === 'deploy' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Deploy bot
              </button>
              <span className="text-[11px] text-slate-500">Registra la strategia (kind: agentic) e avvia il bot. Un super_admin deve operare per conto di un tenant.</span>
            </div>
          </div>
        )}
      </section>

      {/* Variables — the clone-wizard knobs */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 mb-5 shadow-sm">
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

      {/* Inline local tools */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 mb-5 shadow-sm">
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

      {/* Orchestration (teams only) — edge editor + visual graph */}
      {isTeam && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 mb-5 shadow-sm">
          <h2 className="font-semibold mb-3">Orchestration (team DAG)</h2>
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
          <OrchestrationGraph crews={crews} entry={entry} edges={edges} />
        </section>
      )}

      {/* Pricing */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 mb-5 shadow-sm">
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

      {/* spec preview + actions */}
      <details className="rounded-xl border border-slate-200 bg-white p-5 mb-5 shadow-sm">
        <summary className="cursor-pointer font-semibold text-sm">agent_definition (preview)</summary>
        <pre className="text-xs bg-slate-50 border rounded p-3 mt-3 overflow-auto max-h-72">{JSON.stringify(agentDefinition, null, 2)}</pre>
      </details>

      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={saveDraft} disabled={!!busy} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
          {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save draft
        </button>
        <button onClick={submitForApproval} disabled={!!busy} className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
          {busy === 'submit' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Submit for approval
        </button>
        <span className="text-xs text-slate-400">Team profiles are gated to Pro at install.</span>
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
