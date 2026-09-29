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

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Bot, Plus, Trash2, Loader2, Save, Send, Users, Variable, Wrench, Tag } from 'lucide-react';
import { ReactFlow, Background, Controls, type Node, type Edge as FlowEdge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  getAgenticProfile, saveAgenticProfile, publishAgenticProfile,
  allowedAssets, registerStrategy, deployBot as deployBotCall,
} from '../client';

const CATEGORIES = [
  'data_engineer', 'scraping_agent', 'research_agent', 'monitoring_agent',
  'social_distribution', 'support_agent', 'rag_assistant', 'analytics_agent',
  'finance', 'multi_agent_team', 'other',
];
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

  const isTeam = mode === 'team';   // explicit, not inferred from crew count
  const isPaid = priceUnit !== 'free' && Number(priceEur) > 0;

  // Load a PROFILE (Jersey agentic_profiles) into the editor — unified store.
  const loadProfile = (id: string | number) => {
    getAgenticProfile(String(id))
      .then((d: any) => {
        if (d?.error) { setMsg({ kind: 'err', text: d.error }); return; }
        setSavedId(d.id); setStatus(d.status || 'draft'); setSurface(d.surface || 'background');
        setMode(((typeof d.spec === 'string' ? (() => { try { return JSON.parse(d.spec); } catch { return {}; } })() : (d.spec || {}))?.chat_mode === 'team') ? 'team' : 'single');
        let def: any = {};
        try { def = typeof d.spec === 'string' ? JSON.parse(d.spec) : (d.spec || {}); } catch { def = {}; }
        setCode(def.profile || d.name || '');
        setDisplayName(d.name || def.profile || '');
        setVersion(d.version || def.version || '1.0.0');
        setDescription(d.description || def.description || '');
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

      {/* La via FACILE — descrivere l'agente all'assistente — era sepolta in fondo alla pagina
          (dopo Info/Crews/Trading/Variables/Tools/Orchestration/Pricing), invisibile al nuovo utente
          che atterra su un form tecnico che parte da "Code (kebab-case)". Qui e' in CIMA. Per un
          agente nuovo la cornice nomina le due vie; in modifica il testo e' piu' leggero. Il chatSlot
          e' renderizzato UNA sola volta (qui, non piu' in fondo): e' lo stesso nodo, duplicarlo darebbe
          due pannelli con stato separato. */}
      {chatSlot && (
        <div className="mb-5 flex flex-col gap-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-indigo-900">
            {editId
              ? 'Refine this agent conversationally with the assistant, or edit the form below.'
              : 'Start here: describe the agent — or the team — you want and the assistant drafts it for you, ready to review and tweak below. Prefer to build it by hand? Fill in the form.'}
          </p>
          <div className="shrink-0">{chatSlot}</div>
        </div>
      )}

      {msg && (
        <div className={`mb-4 rounded-lg border p-3 text-sm ${msg.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>{msg.text}</div>
      )}

      {/* Info */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 mb-5 shadow-sm">
        <h2 className="font-semibold mb-3">Info</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          <L label="Code (kebab-case)"><input className={inp} value={code} onChange={(e) => setCode(e.target.value)} placeholder="my-agent" /></L>
          <L label="Display name"><input className={inp} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="My Agent" /></L>
          <L label="Version"><input className={inp} value={version} onChange={(e) => setVersion(e.target.value)} /></L>
          <L label="Category"><select className={inp} value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}</select></L>
          <L label="Surface"><select className={inp} value={surface} onChange={(e) => setSurface(e.target.value)} title="chat = persona selectable in the chat · background = CrewAI/Ray batch (schedule/trigger) · both">
            <option value="background">⚙ background (batch)</option>
            <option value="chat">💬 chat (persona)</option>
            <option value="both">both</option>
          </select></L>
          <L label="Tags (comma-sep)"><input className={inp} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="etl, scraping" /></L>
          <L label="Required capabilities (comma-sep)"><input className={inp} value={requiredCaps} onChange={(e) => setRequiredCaps(e.target.value)} placeholder="webrobot_mcp, postiz_mcp" /></L>
        </div>
        <L label="Description" className="mt-3"><textarea className={inp + ' h-20'} value={description} onChange={(e) => setDescription(e.target.value)} /></L>
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
              <div className="flex items-center gap-2 mb-2">
                <input className={inp + ' max-w-[140px]'} value={c.id} onChange={(e) => setCrew(i, { id: e.target.value })} placeholder="id" />
                <select className={inp + ' max-w-[130px]'} value={c.engine} onChange={(e) => setCrew(i, { engine: e.target.value })}>{ENGINES.map((en) => <option key={en} value={en}>{en}</option>)}</select>
                <input className={inp} value={c.model} onChange={(e) => setCrew(i, { model: e.target.value })} placeholder="model" />
                {crews.length > 1 && <button onClick={() => removeCrew(i)} className="text-slate-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>}
              </div>
              <textarea className={inp + ' h-16 mb-2'} value={c.system_prompt} onChange={(e) => setCrew(i, { system_prompt: e.target.value })} placeholder="system prompt (use {{variable}} to inject declared variables)" />
              <input className={inp + ' mb-2'} value={c.mcp_url} onChange={(e) => setCrew(i, { mcp_url: e.target.value })} placeholder="MCP url (optional, e.g. https://mcp.webrobot.eu/mcp)" />
              {/* Runtime & safety — now editable in the form (previously YAML-only and silently dropped on edit). */}
              <div className="grid sm:grid-cols-2 gap-2">
                <L label="Permission mode"><select className={inp} value={c.permission_mode} onChange={(e) => setCrew(i, { permission_mode: e.target.value })}>{PERMISSION_MODES.map((p) => <option key={p} value={p}>{p || '(default)'}</option>)}</select></L>
                <L label="Max turns"><input className={inp} type="number" min="1" value={c.max_turns} onChange={(e) => setCrew(i, { max_turns: e.target.value })} placeholder="e.g. 20" /></L>
                <L label="Max budget (USD/turn)"><input className={inp} type="number" min="0" step="0.01" value={c.max_budget_usd} onChange={(e) => setCrew(i, { max_budget_usd: e.target.value })} placeholder="e.g. 0.50" /></L>
                <L label="Disallowed tools (comma-sep)"><input className={inp} value={c.disallowed_tools} onChange={(e) => setCrew(i, { disallowed_tools: e.target.value })} placeholder="e.g. Bash, mcp__camoufox__agentic_browse" /></L>
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
          <L label="Price model"><select className={inp} value={priceUnit} onChange={(e) => setPriceUnit(e.target.value)}>{PRICE_UNITS.map((u) => <option key={u} value={u}>{u.replace(/_/g, ' ')}</option>)}</select></L>
          <L label="Price (€)"><input className={inp} type="number" min="0" step="0.01" value={priceEur} onChange={(e) => setPriceEur(e.target.value)} disabled={priceUnit === 'free'} /></L>
          <L label="Revenue share to you (%)"><input className={inp} type="number" min="0" max="100" value={revenueShare} onChange={(e) => setRevenueShare(e.target.value)} disabled={priceUnit === 'free'} /></L>
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
function L({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return <label className={`block ${className}`}><span className="text-xs font-medium text-slate-700">{label}</span><div className="mt-1">{children}</div></label>;
}
