'use client';
// Test panel of the Agent Studio (redesign 10-23, after Copilot Studio / Dify / CrewAI): talk to the
// agent you are editing and SEE what it did — each tool call, its result and what the agent said —
// next to the form, instead of leaving the studio to find a run's logs.
//
// A test is a real run of the SAVED profile (POST /agentic/start with the message as goal): unsaved
// edits are not in it, and the panel says so. The trace comes from the run's log (AGENTIC-TRACE lines),
// polled while it runs.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Send, Wrench, CornerDownRight, MessageSquare, AlertTriangle, RotateCcw } from 'lucide-react';
import {
  startAgentTestRun, getAgentRunStatus, getAgentRunLogs, parseAgentTrace, agentRunText,
  AgentStudioError, type TraceStep,
} from '../client';

interface Turn { message: string; executionId?: string; status: string; answer?: string | null; error?: string | null; steps: TraceStep[] }

const TERMINAL = ['COMPLETED', 'FAILED', 'STOPPED', 'CANCELLED', 'SUCCEEDED'];

export default function TestPanel({ profileId, dirty }: { profileId?: string | null; dirty?: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const update = (i: number, patch: Partial<Turn>) =>
    setTurns((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  const send = useCallback(async () => {
    const message = text.trim();
    if (!message || !profileId || busy) return;
    setText(''); setBusy(true);
    const i = turns.length;
    setTurns((ts) => [...ts, { message, status: 'STARTING', steps: [] }]);
    try {
      const run = await startAgentTestRun(profileId, message);
      const eid = run?.executionId;
      if (!eid) throw new Error('the run did not start');
      update(i, { executionId: eid, status: 'PENDING' });
      const t0 = Date.now();
      while (alive.current && Date.now() - t0 < 15 * 60 * 1000) {
        await new Promise((r) => setTimeout(r, 4000));
        const [st, lg] = await Promise.all([
          getAgentRunStatus(eid).catch(() => null),
          getAgentRunLogs(eid).catch(() => null),
        ]);
        const status = String(st?.persistedStatus || st?.status || 'RUNNING').toUpperCase();
        update(i, { status, steps: parseAgentTrace(lg?.logs) });
        if (TERMINAL.includes(status)) {
          update(i, { answer: agentRunText(st?.result), error: st?.errorMessage || null });
          break;
        }
      }
    } catch (e) {
      update(i, { status: 'FAILED', error: e instanceof AgentStudioError ? `run → ${e.status}` : String((e as Error)?.message || e) });
    } finally {
      setBusy(false);
    }
  }, [text, profileId, busy, turns.length]);

  return (
    <aside className="flex h-full min-h-[520px] flex-col rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
        <MessageSquare className="h-4 w-4 text-brand-600" />
        <h3 className="text-base font-semibold text-slate-900">Test your agent</h3>
        {turns.length > 0 && (
          <button type="button" onClick={() => setTurns([])} disabled={busy}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 disabled:opacity-50"
            title="Start a new test session">
            <RotateCcw className="h-3.5 w-3.5" /> New session
          </button>
        )}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {!profileId && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Save the agent first — a test runs the saved profile.
          </p>
        )}
        {profileId && dirty && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            You have unsaved changes: the test runs the last saved version.
          </p>
        )}
        {profileId && turns.length === 0 && (
          <p className="text-sm leading-relaxed text-slate-500">
            Write what you would ask the agent. It runs for real on the platform; you see each step it takes —
            the tools it calls and what they return — and its answer.
          </p>
        )}
        {turns.map((t, i) => (
          <div key={i} className="space-y-2">
            <div className="ml-auto max-w-[90%] rounded-2xl rounded-br-sm bg-brand-600 px-3 py-2 text-sm text-white">{t.message}</div>
            {t.steps.length > 0 && (
              <ol className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-2">
                {t.steps.map((s, k) => (
                  <li key={k} className="text-xs leading-snug">
                    {s.kind === 'call' && (
                      <span className="flex items-start gap-1.5 text-slate-800">
                        <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-600" />
                        <span><b className="font-semibold">{s.label}</b>{s.node && <span className="text-slate-400"> · {s.node}</span>}
                          <details className="inline"><summary className="ml-1 inline cursor-pointer text-slate-400">args</summary>
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-1.5 text-[11px] text-slate-600">{s.detail}</pre></details></span>
                      </span>
                    )}
                    {s.kind === 'result' && (
                      <span className={`flex items-start gap-1.5 ${s.label === 'error' ? 'text-rose-700' : 'text-slate-600'}`}>
                        {s.label === 'error' ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />}
                        <span className="line-clamp-2 break-all">{s.detail}</span>
                      </span>
                    )}
                    {s.kind === 'text' && (
                      <span className="flex items-start gap-1.5 text-slate-700">
                        <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                        <span className="line-clamp-3">{s.detail}</span>
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {!TERMINAL.includes(t.status) && t.status !== 'FAILED' && (
              <p className="flex items-center gap-2 text-sm text-slate-600">
                <Loader2 className="h-4 w-4 animate-spin" /> {t.status === 'STARTING' ? 'Starting the run…' : `Running (${t.status.toLowerCase()})…`}
              </p>
            )}
            {t.answer && (
              <div className="max-w-[95%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-900">{t.answer}</div>
            )}
            {t.error && (
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">{t.error}</p>
            )}
            {TERMINAL.includes(t.status) && !t.answer && !t.error && (
              <p className="text-sm text-slate-500">The run ended ({t.status.toLowerCase()}) without an answer.</p>
            )}
            {t.executionId && <p className="text-[11px] text-slate-400">run {t.executionId}</p>}
          </div>
        ))}
      </div>

      <div className="border-t border-slate-200 p-3">
        <div className="flex items-end gap-2">
          <textarea
            className="min-h-[44px] flex-1 resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-300 focus:ring-1 focus:ring-brand-200"
            placeholder={profileId ? 'Ask the agent something…' : 'Save the agent to test it'}
            value={text}
            rows={2}
            disabled={!profileId || busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <button type="button" onClick={send} disabled={!profileId || busy || !text.trim()}
            className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-brand-900 px-4 text-sm font-semibold text-white hover:bg-brand-950 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Run
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-slate-400">Each test is a real run: it uses tools and is billed like any run.</p>
      </div>
    </aside>
  );
}
