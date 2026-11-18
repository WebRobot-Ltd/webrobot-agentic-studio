'use client';
// Background agent: run it now as a Ray job, put it on a schedule, and see its recent runs with their
// results. Shown for surface "background" / "both" once the profile is saved. Before (11-18) a
// tenant had no way to run or schedule a background agent from the console — only the test panel.
import { useCallback, useEffect, useState } from 'react';
import {
  startBackgroundRun, listProfileRuns, saveAgentSchedule, getAgentRunStatus, agentRunText,
} from '../client';

const PRESETS: { label: string; cron: string }[] = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at 08:00', cron: '0 8 * * *' },
  { label: 'Weekdays at 08:00', cron: '0 8 * * 1-5' },
  { label: 'Every Monday at 08:00', cron: '0 8 * * 1' },
];
const TERMINAL = ['COMPLETED', 'SUCCEEDED', 'FAILED', 'STOPPED', 'CANCELLED'];
const statusOf = (s: any) => String(s?.persistedStatus || s?.status || s?.rayJob?.jobStatus || 'PENDING').toUpperCase();

export default function BackgroundPanel({ profileId, dirty }: { profileId: string | null; dirty?: boolean }) {
  const [goal, setGoal] = useState('');
  const [cron, setCron] = useState(PRESETS[1].cron);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [live, setLive] = useState<{ id: string; status: string; answer?: string | null; error?: string | null } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!profileId) return;
    try { setRuns((await listProfileRuns(profileId)).slice(0, 6)); } catch { /* list is best-effort */ }
  }, [profileId]);
  useEffect(() => { refresh(); }, [refresh]);

  // follow the run just started until it ends
  useEffect(() => {
    if (!live || TERMINAL.includes(live.status)) return;
    const h = setInterval(async () => {
      try {
        const st = await getAgentRunStatus(live.id);
        const s = statusOf(st);
        setLive({ id: live.id, status: s, answer: agentRunText(st?.result), error: st?.errorMessage || null });
        if (TERMINAL.includes(s)) refresh();
      } catch { /* next tick */ }
    }, 5000);
    return () => clearInterval(h);
  }, [live, refresh]);

  if (!profileId) return <p className="text-sm text-slate-500">Save the agent first — background runs use the saved profile.</p>;

  const runNow = async () => {
    setMsg(null);
    try {
      const r: any = await startBackgroundRun(profileId, goal);
      const id = r?.executionId;
      if (!id) throw new Error(r?.error || 'the run did not start');
      setLive({ id, status: 'PENDING' });
      setMsg({ kind: 'ok', text: `Started in the background — run ${id}.` });
      refresh();
    } catch (e: any) { setMsg({ kind: 'err', text: e?.message || 'start failed' }); }
  };
  const schedule = async (enabled: boolean) => {
    setMsg(null);
    try {
      await saveAgentSchedule(profileId, cron, enabled, goal);
      const p = PRESETS.find((x) => x.cron === cron)?.label || cron;
      setMsg({ kind: 'ok', text: enabled ? `Scheduled: ${p.toLowerCase()} (UTC).` : 'Schedule removed.' });
    } catch (e: any) { setMsg({ kind: 'err', text: e?.message || 'schedule failed' }); }
  };

  return (
    <div className="space-y-4">
      {dirty && <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">Unsaved changes: runs use the last saved version.</p>}
      <label className="block">
        <span className="text-xs font-medium text-slate-700">Task for this run (optional)</span>
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} placeholder="e.g. Collect this week's news about our brand and summarise it"
          className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-300 focus:ring-1 focus:ring-brand-200" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={runNow} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Run now</button>
        <span className="text-xs text-slate-500">Runs as a Ray job on the cluster — billed like any run.</span>
      </div>
      <div className="rounded-lg border border-slate-200 p-3">
        <p className="text-xs font-medium text-slate-700">Schedule</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select aria-label="Schedule" value={cron} onChange={(e) => setCron(e.target.value)} className="rounded-md border border-slate-300 px-2 py-2 text-sm">
            {PRESETS.map((p) => <option key={p.cron} value={p.cron}>{p.label}</option>)}
          </select>
          <button type="button" onClick={() => schedule(true)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Save schedule</button>
          <button type="button" onClick={() => schedule(false)} className="rounded-lg px-3 py-2 text-sm text-slate-500 hover:text-slate-800">Remove</button>
        </div>
      </div>
      {msg && <p className={`rounded-md px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>{msg.text}</p>}
      {live && (
        <div className="rounded-lg border border-slate-200 p-3">
          <p className="text-xs text-slate-500">Run <span className="font-mono">{live.id}</span> · <span className="font-semibold text-slate-800">{live.status}</span></p>
          {live.answer && <div className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-sm text-slate-900">{live.answer}</div>}
          {live.error && <p className="mt-2 text-sm text-rose-700">{live.error}</p>}
        </div>
      )}
      <div>
        <p className="text-xs font-medium text-slate-700">Recent runs</p>
        {runs.length === 0 ? <p className="mt-1 text-xs text-slate-500">No runs yet.</p> : (
          <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200">
            {runs.map((r) => {
              const id = String(r.executionId || r.execution_id);
              const s = statusOf(r);
              return (
                <li key={id} className="px-3 py-2 text-sm">
                  <button type="button" onClick={() => setOpen(open === id ? null : id)} className="flex w-full items-center gap-2 text-left">
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${s === 'COMPLETED' || s === 'SUCCEEDED' ? 'bg-emerald-50 text-emerald-700' : TERMINAL.includes(s) ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-600'}`}>{s}</span>
                    <span className="font-mono text-xs text-slate-500">{id}</span>
                    <span className="ml-auto text-xs text-slate-400">{String(r.startedAt || r.started_at || '').replace('T', ' ').slice(0, 16)}</span>
                  </button>
                  {open === id && <div className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-sm text-slate-800">{agentRunText(r.result) || r.errorMessage || '(no result)'}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
