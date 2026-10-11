/**
 * Shared lifecycle of a `webrobot-agent-designer` run, used by both the Agent Studio form
 * ("Propose") and the Canvas ("Generate").
 *
 * The designer run is an ASYNC RayJob (tens of seconds, sometimes minutes): it can outlast the
 * inline wait, or the user can close/navigate away. The executionId is remembered in localStorage
 * and resumed on mount — whether still running or already finished. Every storage access is in
 * try/catch: without storage we simply lose the resume. The key is per context so a run started
 * for one profile/surface is never applied to another.
 */
import {
  getAgentRunStatus, getAgentRunResult, extractAgentDefinition, extractAgentNeeds,
} from './client';

const RUN_KEY = (ctx: string) => `wr_agent_designer_run:${ctx}`;
/** A stored run older than this is dropped instead of resumed. */
export const RUN_MAX_AGE_MS = 30 * 60 * 1000;
/** How long we poll inline before leaving the run to continue in background. */
export const RUN_INLINE_WAIT_MS = 4 * 60 * 1000;
const RUN_POLL_MS = 5000;

export interface StoredRun { executionId: string; prompt: string; startedAt: number; }

export function readStoredRun(ctx: string): StoredRun | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(RUN_KEY(ctx)) : null;
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v.executionId === 'string' ? (v as StoredRun) : null;
  } catch { return null; }
}
export function storeRun(ctx: string, v: StoredRun): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(RUN_KEY(ctx), JSON.stringify(v)); } catch { /* private/quota */ }
}
export function clearStoredRun(ctx: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(RUN_KEY(ctx)); } catch { /* ignore */ }
}

export type DesignerOutcome =
  | { kind: 'definition'; def: any }          // a usable agent_definition
  | { kind: 'needs'; question: string }       // the agent asks for more detail (NEEDS: …)
  | { kind: 'ended'; status: string }         // FAILED / STOPPED
  | { kind: 'pending' }                       // still running after the inline wait
  | { kind: 'empty' };                        // COMPLETED but nothing usable

/**
 * Polls a run until it ends (or the inline wait expires) and reads its outcome. Checks the status
 * BEFORE sleeping, so an already-finished run resolves immediately. Errors from reading the result
 * propagate to the caller. Does not touch storage: the caller clears it on any final outcome.
 */
export async function followAgentDesignerRun(
  executionId: string,
  onStatus?: (status: string) => void,
  inlineWaitMs = RUN_INLINE_WAIT_MS,
): Promise<DesignerOutcome> {
  const deadline = Date.now() + inlineWaitMs;
  let status = '';
  while (Date.now() < deadline) {
    const st = await getAgentRunStatus(executionId).catch(() => null);
    status = String(st?.persistedStatus || st?.status || '');
    if (['COMPLETED', 'FAILED', 'STOPPED'].includes(status)) break;
    onStatus?.(status);
    await new Promise((r) => setTimeout(r, RUN_POLL_MS));
  }
  if (status === 'FAILED' || status === 'STOPPED') return { kind: 'ended', status };
  if (status !== 'COMPLETED') return { kind: 'pending' };
  const result = await getAgentRunResult(executionId);
  const def = extractAgentDefinition(result);
  if (def) return { kind: 'definition', def };
  const question = extractAgentNeeds(result);
  return question ? { kind: 'needs', question } : { kind: 'empty' };
}
