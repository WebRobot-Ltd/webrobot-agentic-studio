'use client';

// Agent Studio — Canvas (node-based). Author an agent team as a GRAPH: each agent is a node,
// edges are the orchestration flow. Produces the agent_definition
// { profile, crews, chat_mode, orchestration:{type,entry,nodes,edges} } the Ray runner consumes,
// saved as a Jersey agentic_profile (spec = agent_definition) and published via the marketplace
// route. Ported from the WebRobot dashboard; only the app couplings are removed:
// API calls go through the injected client, and the JWT/paths come from configureAgentStudio().
//
//   kind 'rag'       → retrieval assistant (RAG knowledge index + answer)
//   kind 'agent'     → tool-using agent (MCP tools)
//   kind 'hitl'      → human-in-the-loop gate (ask_human: approve/revise/skip)
//   kind 'publisher' → side-effecting output (e.g. post via an MCP)
// approach: 'rag' (single) · 'sequential' (forward DAG) · 'loop' (feedback edge).

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  addEdge, useNodesState, useEdgesState, Handle, Position,
  type Node, type Edge, type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Bot, Trash2, Save, Send, Brain, Wrench, UserCheck, Megaphone, Flag, Sparkles, Loader2 } from 'lucide-react';
import {
  generateAgents, saveAgenticProfile, publishAgenticProfile, AgentStudioError,
} from '../client';

type Kind = 'rag' | 'agent' | 'hitl' | 'publisher';
interface NodeData {
  label: string; kind: Kind; model: string;
  system_prompt: string; goal: string; mcp_url: string;
  rag: boolean; max_turns: number; entry: boolean;
  [k: string]: unknown;
}

const KIND_META: Record<Kind, { name: string; icon: any; color: string; prompt: string }> = {
  rag:       { name: 'RAG assistant', icon: Brain,     color: '#2563eb', prompt: 'You answer from the knowledge base. Retrieve relevant context, then answer with citations.' },
  agent:     { name: 'Tool agent',    icon: Wrench,    color: '#7c3aed', prompt: 'You are a tool-using WebRobot agent. Use your MCP tools to complete the task.' },
  hitl:      { name: 'HITL gate',     icon: UserCheck, color: '#d97706', prompt: 'Prepare the item, then call ask_human for approval. On "ok" proceed; on feedback revise and re-ask; on "skip" stop.' },
  publisher: { name: 'Publisher',     icon: Megaphone, color: '#059669', prompt: 'Publish the approved output VERBATIM via your MCP tool.' },
};

const MODELS = ['claude-sonnet-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-1'];
const CATEGORIES = ['data_engineer', 'scraping_agent', 'research_agent', 'monitoring_agent',
  'social_distribution', 'support_agent', 'rag_assistant', 'analytics_agent', 'multi_agent_team', 'other'];

// ── custom node ────────────────────────────────────────────────────────────
function AgentNode({ data, selected }: { data: NodeData; selected: boolean }) {
  const m = KIND_META[data.kind];
  const Icon = m.icon;
  return (
    <div style={{ borderColor: selected ? m.color : '#e2e8f0' }}
         className="rounded-lg border-2 bg-white shadow-sm min-w-[180px]">
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2 px-3 py-2 rounded-t-md text-white" style={{ background: m.color }}>
        <Icon className="h-4 w-4" />
        <span className="font-semibold text-sm truncate">{data.label || '(unnamed)'}</span>
        {data.entry && <Flag className="h-3 w-3 ml-auto" />}
      </div>
      <div className="px-3 py-2 text-xs text-slate-600">
        <div className="font-medium" style={{ color: m.color }}>{m.name}</div>
        <div className="truncate">{data.model}</div>
        <div className="flex gap-1 mt-1 flex-wrap">
          {data.rag && <span className="rounded bg-blue-50 text-blue-700 px-1">RAG</span>}
          {data.mcp_url && <span className="rounded bg-violet-50 text-violet-700 px-1">MCP</span>}
          {data.kind === 'hitl' && <span className="rounded bg-amber-50 text-amber-700 px-1">ask_human</span>}
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { agent: AgentNode };

let _id = 1;
const newId = (kind: Kind) => `${kind}${_id++}`;

/**
 * @param chatSlot optional "design with chat" panel injected by the host — the same slot the
 *   pipeline studio uses. The package does not bundle a chat component; the host passes one.
 */
function Canvas({ chatSlot }: { chatSlot?: ReactNode }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [approach, setApproach] = useState<'rag' | 'sequential' | 'loop'>('sequential');

  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [version] = useState('1.0.0');
  const [category, setCategory] = useState('multi_agent_team');
  const [tags, setTags] = useState('');
  const [description, setDescription] = useState('');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [status, setStatus] = useState('new');
  const [msg, setMsg] = useState<{ k: 'ok' | 'err'; t: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const addNode = (kind: Kind) => {
    const id = newId(kind);
    const first = nodes.length === 0;
    setNodes((ns) => [...ns, {
      id, type: 'agent', position: { x: 60 + ns.length * 60, y: 80 + ns.length * 50 },
      data: { label: id, kind, model: MODELS[0], system_prompt: KIND_META[kind].prompt,
        goal: nodes.length ? '{' + (nodes[nodes.length - 1].id) + '}' : '', mcp_url: kind === 'agent' || kind === 'publisher' ? 'https://mcp.webrobot.eu/mcp' : '',
        rag: kind === 'rag', max_turns: kind === 'hitl' ? 20 : 12, entry: first },
    }]);
    setSelId(id);
  };

  const [nlPrompt, setNlPrompt] = useState('');
  const [gen, setGen] = useState(false);

  const loadFromDef = (def: any) => {
    const crews: any[] = def?.crews || [];
    const orch = def?.orchestration || {};
    const ns: Node<NodeData>[] = crews.map((c, i) => {
      const kind: Kind = (['rag', 'agent', 'hitl', 'publisher'].includes(c.kind) ? c.kind
        : c.mcp_servers?.some((m: any) => m.name === 'rag') ? 'rag'
        : /ask_human|hitl|approv/i.test(c.system_prompt || '') ? 'hitl'
        : /publish|post /i.test(c.system_prompt || '') ? 'publisher' : 'agent') as Kind;
      const mcp = (c.mcp_servers || []).find((m: any) => m.name !== 'rag');
      return {
        id: c.id, type: 'agent', position: { x: 40 + i * 240, y: 120 + (i % 2) * 120 },
        data: {
          label: c.id, kind, model: c.model || MODELS[0],
          system_prompt: c.system_prompt || KIND_META[kind].prompt, goal: c.goal || '',
          mcp_url: mcp?.url || '', rag: !!c.mcp_servers?.some((m: any) => m.name === 'rag'),
          max_turns: c.max_turns || 12, entry: c.id === (orch.entry || crews[0]?.id),
        },
      };
    });
    const es: Edge[] = (orch.edges || []).map((e: any, i: number) => ({
      id: `e${i}`, source: e.from, target: e.to, animated: orch.type === 'loop',
    }));
    setNodes(ns); setEdges(es);
    if (['rag', 'sequential', 'loop'].includes(orch.type)) setApproach(orch.type);
    setSelId(null);
  };

  const generate = async () => {
    if (!nlPrompt.trim()) { setMsg({ k: 'err', t: 'Describe the agent/team you want.' }); return; }
    setGen(true); setMsg(null);
    try {
      const j = await generateAgents(nlPrompt, approach);
      const def = j.agent_definition || j.data?.agent_definition || j;
      if (!def?.crews?.length) throw new Error('generator returned no crews');
      loadFromDef(def);
      if (j.code && !code) setCode(j.code);
      if (j.display_name && !displayName) setDisplayName(j.display_name);
      setMsg({ k: 'ok', t: `Generated ${def.crews.length} agent(s) — review on the canvas, then Save/Publish.` });
    } catch (e: any) { setMsg({ k: 'err', t: `Generate failed: ${e.message}` }); }
    finally { setGen(false); }
  };

  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge({ ...c, animated: approach === 'loop' }, es)), [approach, setEdges]);
  const patch = (id: string, p: Partial<NodeData>) =>
    setNodes((ns) => ns.map((n) => n.id === id ? { ...n, data: { ...n.data, ...p } } : n));
  const sel = nodes.find((n) => n.id === selId);

  const setEntry = (id: string) => setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, entry: n.id === id } })));
  const delNode = (id: string) => { setNodes((ns) => ns.filter((n) => n.id !== id)); setEdges((es) => es.filter((e) => e.source !== id && e.target !== id)); setSelId(null); };

  const agentDef = useMemo(() => {
    const crews = nodes.map((n) => {
      const d = n.data;
      const crew: any = { id: n.id, kind: d.kind, model: d.model, system_prompt: d.system_prompt, max_turns: d.max_turns };
      if (d.goal) crew.goal = d.goal;
      const mcp: any[] = [];
      if (d.mcp_url) mcp.push({ name: 'mcp', type: 'http', url: d.mcp_url, allow: 'all' });
      if (d.rag) mcp.push({ name: 'rag', type: 'http', url: 'https://mcp-full.webrobot.eu/mcp', allow: ['ragQuery', 'ragStatus'] });
      if (mcp.length) crew.mcp_servers = mcp;
      return crew;
    });
    const entry = (nodes.find((n) => n.data.entry) || nodes[0])?.id;
    const e = edges.map((x) => ({ from: x.source, to: x.target }));
    const team = nodes.length > 1;
    const def: any = { profile: code || 'profile', crews };
    if (team) {
      def.chat_mode = 'team';
      // `nodes` is what the Ray runner builds its topological order from. Emitting only
      // {entry, edges} leaves it empty, and its emptiness check compares len(order) to
      // len(nodes) — 0 to 0 — so a studio-authored team RUNS, reports SUCCEEDED and executes
      // no agent at all. One node per crew, id == crew id, matching the edges' references.
      def.orchestration = {
        type: 'dag',
        entry,
        nodes: crews.map((c: any) => ({ id: c.id, crew: c.id })),
        edges: e,
      };
    }
    return def;
  }, [nodes, edges, approach, code]);

  const isTeam = nodes.length > 1;
  // Canonical persistence: author a Jersey agentic_profile (spec = agent_definition), publish via
  // the marketplace route — the same unified store the dashboard editor and clone wizard use.
  // (Not the legacy agent-templates routes, whose store the runtime no longer reads.)
  const body = () => ({
    name: (code || displayName || 'agent-profile').trim(),
    version, description,
    surface: 'both',
    spec: JSON.stringify(agentDef),
  });

  const save = async () => {
    if (!code) { setMsg({ k: 'err', t: 'Set a code (kebab-case) first.' }); return; }
    if (!nodes.length) { setMsg({ k: 'err', t: 'Add at least one agent node.' }); return; }
    setBusy('save'); setMsg(null);
    try {
      const j = await saveAgenticProfile(body(), savedId || undefined);
      const id = j?.id ?? j?.data?.id ?? savedId; setSavedId(id); setStatus('draft');
      setMsg({ k: 'ok', t: `Profile saved (id ${id}).` }); return id;
    } catch (e: any) { setMsg({ k: 'err', t: e instanceof AgentStudioError ? e.message : String(e) }); return null; }
    finally { setBusy(null); }
  };
  const submit = async () => {
    const id = savedId || (await save()); if (!id) return;
    setBusy('submit');
    try {
      await publishAgenticProfile({
        profileId: id,
        displayName: (displayName || code).trim(),
        description, category,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        priceUnit: 'free', priceAmount: 0,
        locked: false, revenueSharePercent: 0,
        requiredCapabilities: ['webrobot_mcp'],
        ipDisclaimerAccepted: true,
      });
      setStatus('pending_approval'); setMsg({ k: 'ok', t: 'Published for approval.' });
    } catch (e: any) { setMsg({ k: 'err', t: e instanceof AgentStudioError ? e.message : String(e) }); }
    finally { setBusy(null); }
  };

  const inp = 'w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm';

  return (
    <div className="h-[calc(100vh-3rem)] flex flex-col text-slate-900">
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-white">
        <Bot className="h-5 w-5 text-indigo-600" />
        <h1 className="font-semibold">Agent Studio — Canvas</h1>
        <span className="ml-2 text-xs text-slate-500">status <b>{status}</b>{savedId ? ` · id ${savedId}` : ''}</span>
        <div className="ml-auto flex items-center gap-2">
          {chatSlot}
          <label className="text-xs text-slate-500">approach</label>
          <select className="rounded-md border border-slate-300 text-sm px-2 py-1" value={approach} onChange={(e) => setApproach(e.target.value as any)}>
            <option value="rag">RAG (single)</option>
            <option value="sequential">Sequential team</option>
            <option value="loop">Agentic loop</option>
          </select>
          <button onClick={save} disabled={!!busy} className="inline-flex items-center gap-1 rounded-md bg-slate-800 text-white text-sm px-3 py-1.5"><Save className="h-4 w-4" /> Save</button>
          <button onClick={submit} disabled={!!busy} className="inline-flex items-center gap-1 rounded-md bg-indigo-600 text-white text-sm px-3 py-1.5"><Send className="h-4 w-4" /> Publish</button>
        </div>
      </div>
      {msg && <div className={`px-4 py-1.5 text-sm ${msg.k === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{msg.t}</div>}

      <div className="flex-1 flex min-h-0">
        <div className="w-44 border-r bg-slate-50 p-3 space-y-2 overflow-auto">
          <div className="text-xs font-semibold text-slate-500 uppercase">Add agent</div>
          {(Object.keys(KIND_META) as Kind[]).map((k) => {
            const m = KIND_META[k]; const Icon = m.icon;
            return (
              <button key={k} onClick={() => addNode(k)} className="w-full flex items-center gap-2 rounded-md border bg-white px-2 py-2 text-sm hover:shadow">
                <Icon className="h-4 w-4" style={{ color: m.color }} /> {m.name}
              </button>
            );
          })}
          <div className="pt-3 border-t mt-3 space-y-2">
            <div className="text-xs font-semibold text-slate-500 uppercase">Listing</div>
            <input className={inp} placeholder="code (kebab-case)" value={code} onChange={(e) => setCode(e.target.value)} />
            <input className={inp} placeholder="display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            <select className={inp} value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}</select>
            <input className={inp} placeholder="tags, comma" value={tags} onChange={(e) => setTags(e.target.value)} />
            <textarea className={inp + ' h-16'} placeholder="description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onNodeClick={(_, n) => setSelId(n.id)} onPaneClick={() => setSelId(null)} fitView>
            <Background /><Controls /><MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        <div className="w-80 border-l bg-white p-4 overflow-auto">
          {!sel ? (
            <div className="text-sm text-slate-500">
              <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50/50 p-3">
                <div className="flex items-center gap-1.5 font-semibold text-indigo-700 mb-1"><Sparkles className="h-4 w-4" /> Describe it — I&apos;ll model the team</div>
                <textarea className={inp + ' h-24'} value={nlPrompt} onChange={(e) => setNlPrompt(e.target.value)}
                  placeholder="e.g. A team that scrapes today's DeFi news, drafts a Telegram post, asks me to approve, then publishes it." />
                <button onClick={generate} disabled={gen} className="mt-2 w-full inline-flex items-center justify-center gap-1.5 rounded-md bg-indigo-600 text-white py-1.5 disabled:opacity-60">
                  {gen ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Generate the graph
                </button>
                <p className="mt-1 text-[11px] text-slate-500">Generates agents + connections on the canvas. Review and edit, then Save/Publish.</p>
              </div>
              <p className="mb-2">Or build by hand: add agents from the palette, drag to connect them (edge = flow). Click a node to edit it.</p>
              <p>Entry node is flagged 🚩. The graph below is saved as <code>agent_definition</code>.</p>
              <details className="mt-3"><summary className="cursor-pointer font-medium">agent_definition preview</summary>
                <pre className="mt-2 text-[10px] bg-slate-900 text-slate-100 rounded p-2 overflow-auto max-h-72">{JSON.stringify(agentDef, null, 2)}</pre>
              </details>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{KIND_META[sel.data.kind].name}</h3>
                <div className="flex gap-1">
                  <button title="set as entry" onClick={() => setEntry(sel.id)} className={`rounded p-1 ${sel.data.entry ? 'bg-amber-100 text-amber-700' : 'text-slate-400 hover:bg-slate-100'}`}><Flag className="h-4 w-4" /></button>
                  <button title="delete" onClick={() => delNode(sel.id)} className="rounded p-1 text-slate-400 hover:text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
              <label className="block">id<input className={inp} value={sel.data.label} onChange={(e) => patch(sel.id, { label: e.target.value })} /></label>
              <label className="block">model<select className={inp} value={sel.data.model} onChange={(e) => patch(sel.id, { model: e.target.value })}>{MODELS.map((m) => <option key={m}>{m}</option>)}</select></label>
              <label className="block">system prompt<textarea className={inp + ' h-24'} value={sel.data.system_prompt} onChange={(e) => patch(sel.id, { system_prompt: e.target.value })} /></label>
              <label className="block">goal (use {'{parentId}'} to inject upstream output)<textarea className={inp + ' h-16'} value={sel.data.goal} onChange={(e) => patch(sel.id, { goal: e.target.value })} /></label>
              <label className="block">MCP url (tools)<input className={inp} value={sel.data.mcp_url} onChange={(e) => patch(sel.id, { mcp_url: e.target.value })} placeholder="https://mcp.webrobot.eu/mcp" /></label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={sel.data.rag} onChange={(e) => patch(sel.id, { rag: e.target.checked })} /> RAG knowledge index</label>
              <label className="block">max turns<input type="number" className={inp} value={sel.data.max_turns} onChange={(e) => patch(sel.id, { max_turns: Number(e.target.value) })} /></label>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AgentCanvas({ chatSlot }: { chatSlot?: ReactNode }) {
  return <ReactFlowProvider><Canvas chatSlot={chatSlot} /></ReactFlowProvider>;
}
