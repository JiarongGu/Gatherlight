// The chat's state machine. Lifted out of ChatPanel, which had reached 1517 lines holding this, the
// approval cards, the transcript rows and the orchestrator all at once.
//
// It moved FIRST because it is the piece with no JSX in it: a reducer over SSE events, plus the
// segment bookkeeping that lets an interleaved `ui` block land back where the agent wrote it. None of
// that needs a DOM to be true, and none of it should need a component file to be read.
import type { AgentEvent, Phase, UiBlockEvent, ReviewPayload, McpProposalView, McpLoginView, DraftApprovalView, CapabilityApprovalView } from '@/lib/chatTypes';

/**
 * One piece of an assistant turn, in the order the server segmented it. Prose and `ui` blocks
 * interleave by `index` — that index is what lets the transcript put a block back exactly where the
 * agent wrote it instead of guessing (a block appended at the end reads as a non-sequitur).
 */
export type Segment =
  | { kind: 'prose'; index: number; text: string }
  | { kind: 'block'; index: number; block: UiBlockEvent };

/** Append prose to the segment at `index`, creating it if this is its first delta. */
export function upsertProse(segments: Segment[], index: number, text: string): Segment[] {
  const at = segments.findIndex((s) => s.index === index && s.kind === 'prose');
  if (at < 0) return [...segments, { kind: 'prose', index, text }];
  const next = segments.slice();
  next[at] = { kind: 'prose', index, text: (next[at] as { text: string }).text + text };
  return next;
}

/** Upsert a block at its index — a later ready/invalid REPLACES the partial placeholder. */
export function upsertBlock(segments: Segment[], block: UiBlockEvent): Segment[] {
  const at = segments.findIndex((s) => s.index === block.segment && s.kind === 'block');
  if (at < 0) return [...segments, { kind: 'block', index: block.segment, block }];
  const next = segments.slice();
  next[at] = { kind: 'block', index: block.segment, block };
  return next;
}

/** A turn with nothing but whitespace prose is not worth a transcript row. */
export const hasContent = (segments: Segment[]) =>
  segments.some((s) => (s.kind === 'prose' ? s.text.trim().length > 0 : true));

export const byIndex = (segments: Segment[]) => segments.slice().sort((a, b) => a.index - b.index);

export interface TranscriptItem {
  id: number;
  role: 'user' | 'assistant' | 'notice' | 'tool' | 'divider';
  text?: string;
  /** Assistant rows only — the ordered segments of that turn. */
  segments?: Segment[];
  tool?: { name: string; detail?: string };
}

export interface ChatState {
  sessionId: string | null;
  phase: Phase;
  items: TranscriptItem[];
  live: Segment[]; // the in-flight assistant turn, as ordered segments
  thinking: string;
  review: ReviewPayload | null;
  // The agent's question when it paused (phase 'awaiting-input'); shown as a prompt to reply to.
  inputQuestion: string | null;
  // Discrete choices the agent offered (OPTION: lines) — rendered as click-to-select buttons.
  inputOptions: string[];
  // The agent's proposal to add an external MCP server (phase 'awaiting-mcp-approval').
  mcpProposal: McpProposalView | null;
  // The agent's request to log into an MCP server (phase 'awaiting-login').
  mcpLogin: McpLoginView | null;
  // The agent wrote a tool and wants it enabled (phase 'awaiting-draft-approval').
  draftApproval: DraftApprovalView | null;
  // A capability call was refused mid-run; the agent is asking to widen its grant
  // (phase 'awaiting-capability-approval').
  capabilityApproval: CapabilityApprovalView | null;
  commitSha: string | null;
  error: string | null;
  busy: boolean; // an approve/reject request is in flight
  // Cumulative session usage (committed via one 'usage' event per CLI run: plan / execute / refine…).
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };
  // Live usage of the IN-FLIGHT run — accumulates 'usage-live' ticks (per assistant turn) so tokens
  // climb visibly during a long plan/research phase; reset to zero when the run's 'usage' total commits.
  liveUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

export const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
export const ZERO_LIVE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

export const initialState: ChatState = {
  sessionId: null,
  phase: 'idle',
  items: [],
  live: [],
  thinking: '',
  review: null,
  inputQuestion: null,
  inputOptions: [],
  mcpProposal: null,
  mcpLogin: null,
  draftApproval: null,
  capabilityApproval: null,
  commitSha: null,
  error: null,
  busy: false,
  usage: ZERO_USAGE,
  liveUsage: ZERO_LIVE
};

let seq = 0;
export const nextId = () => ++seq;

export const SESSION_KEY = 'viewer-chat-session';
// Persist the unsent input so closing/reopening the chat drawer (or a reload) doesn't lose it.
export const DRAFT_KEY = 'viewer-chat-draft';

// Clickable starter prompts for the empty chat — a new user's fastest way in.
export const CHAT_STARTERS = [
  '把日本行程 Day 3 改成京都一日游',
  '在 household 里记一下家人的饮食偏好',
  '给 8 月日本之行建一个打包清单',
];

export type Action =
  | { type: 'reset'; sessionId: string; message: string }
  | { type: 'rehydrate'; sessionId: string }
  | { type: 'refine'; phase: Phase; message: string }
  | { type: 'event'; ev: AgentEvent }
  | { type: 'busy'; value: boolean };

export function flushLive(state: ChatState): TranscriptItem[] {
  if (!hasContent(state.live)) return state.items;
  return [...state.items, { id: nextId(), role: 'assistant', segments: byIndex(state.live) }];
}

export function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'reset':
      // New turn — keep the visible conversation, just append a separator + the
      // new user message. (Each turn still runs as a fresh CLI session server-side.)
      return {
        ...state,
        sessionId: action.sessionId,
        phase: 'planning',
        items: [
          ...state.items,
          ...(state.items.length ? [{ id: nextId(), role: 'divider' as const }] : []),
          { id: nextId(), role: 'user' as const, text: action.message }
        ],
        live: [],
        thinking: '',
        review: null,
        inputQuestion: null,
        inputOptions: [],
        mcpProposal: null,
        mcpLogin: null,
        draftApproval: null,
        capabilityApproval: null,
        commitSha: null,
        error: null,
        busy: false,
        usage: ZERO_USAGE,
        liveUsage: ZERO_LIVE
      };

    case 'rehydrate':
      // Reconnecting to a session after a reload — the backend replays its event
      // log, which repopulates phase / transcript / review.
      return { ...initialState, sessionId: action.sessionId };

    case 'refine':
      // Talking back at a gate: append the user's message and re-enter the
      // working phase optimistically (the SSE phase event confirms it). Same
      // session — the stream stays open; the old plan/review is now stale.
      return {
        ...state,
        phase: action.phase,
        items: [...state.items, { id: nextId(), role: 'user' as const, text: action.message }],
        live: [],
        thinking: '',
        review: null,
        inputQuestion: null,
        inputOptions: [],
        mcpProposal: null,
        mcpLogin: null,
        draftApproval: null,
        capabilityApproval: null,
        error: null,
        busy: false
      };

    case 'busy':
      return { ...state, busy: action.value };

    case 'event': {
      const ev = action.ev;
      switch (ev.kind) {
        case 'user':
          // Replay only: the live path adds the user's row from the composer ('reset'). Same rows,
          // same separator — a replayed conversation must not look different from the live one.
          return {
            ...state,
            items: [
              ...flushLive(state),
              ...(state.items.length ? [{ id: nextId(), role: 'divider' as const }] : []),
              { id: nextId(), role: 'user' as const, text: ev.text ?? '' }
            ],
            live: [],
            thinking: ''
          };

        case 'text-delta': {
          // `data.segment` is the server scanner's index for this run of prose. Default 0 so a
          // producer that never segments (an older server, a non-chat caller) still renders.
          const index = (ev.data as { segment?: number } | undefined)?.segment ?? 0;
          return { ...state, live: upsertProse(state.live, index, ev.text ?? '') };
        }

        case 'ui-block': {
          const block = ev.data as UiBlockEvent | undefined;
          if (!block) return state;
          return { ...state, live: upsertBlock(state.live, block) };
        }

        case 'usage': {
          // Authoritative per-run total — commit it to the session usage and clear the live counter
          // (whose ticks approximated this same run and are now superseded).
          const u = (ev.data ?? {}) as Partial<ChatState['usage']>;
          return {
            ...state,
            usage: {
              inputTokens: state.usage.inputTokens + (u.inputTokens ?? 0),
              outputTokens: state.usage.outputTokens + (u.outputTokens ?? 0),
              cacheReadTokens: state.usage.cacheReadTokens + (u.cacheReadTokens ?? 0),
              costUsd: state.usage.costUsd + (u.costUsd ?? 0)
            },
            liveUsage: ZERO_LIVE
          };
        }

        case 'usage-live': {
          // Ephemeral per-turn tick — accumulate into the in-flight run's live counter so tokens climb
          // visibly during a long plan/research phase. Reset when the run's 'usage' total commits.
          const u = (ev.data ?? {}) as Partial<ChatState['liveUsage']>;
          return {
            ...state,
            liveUsage: {
              inputTokens: state.liveUsage.inputTokens + (u.inputTokens ?? 0),
              outputTokens: state.liveUsage.outputTokens + (u.outputTokens ?? 0),
              cacheReadTokens: state.liveUsage.cacheReadTokens + (u.cacheReadTokens ?? 0)
            }
          };
        }

        case 'thinking':
          return { ...state, thinking: state.thinking + (ev.text ?? '') };

        case 'text':
          // Full block — authoritative; replaces whatever streamed into `live`. It arrives
          // unsegmented, so it becomes one prose segment.
          return {
            ...state,
            items: [
              ...state.items,
              { id: nextId(), role: 'assistant', segments: [{ kind: 'prose', index: 0, text: ev.text ?? '' }] }
            ],
            live: [],
            thinking: ''
          };

        case 'tool':
          return {
            ...state,
            items: [
              ...flushLive(state),
              { id: nextId(), role: 'tool', tool: ev.tool }
            ],
            live: []
          };

        case 'notice':
          return {
            ...state,
            items: [
              ...flushLive(state),
              { id: nextId(), role: 'notice', text: ev.text }
            ],
            live: []
          };

        case 'phase': {
          const phase = ev.phase ?? state.phase;
          const next: ChatState = {
            ...state,
            phase,
            busy: false,
            items: flushLive(state),
            live: []
          };
          if (phase === 'awaiting-diff-approval' && ev.data) {
            next.review = ev.data as ReviewPayload;
          }
          if (phase === 'awaiting-input') {
            const d = ev.data as { question?: string; options?: string[] } | undefined;
            next.inputQuestion = d?.question ?? null;
            next.inputOptions = d?.options ?? [];
          }
          if (phase === 'awaiting-mcp-approval') {
            next.mcpProposal = (ev.data as McpProposalView) ?? null;
          }
          if (phase === 'awaiting-login') {
            next.mcpLogin = (ev.data as McpLoginView) ?? null;
          }
          if (phase === 'awaiting-draft-approval') {
            next.draftApproval = (ev.data as DraftApprovalView) ?? null;
          }
          if (phase === 'awaiting-capability-approval') {
            next.capabilityApproval = (ev.data as CapabilityApprovalView) ?? null;
          }
          if (phase === 'committed' && ev.data) {
            next.commitSha = (ev.data as { sha?: string }).sha ?? null;
          }
          return next;
        }

        case 'error':
          return {
            ...state,
            error: ev.text ?? '出错了',
            items: flushLive(state),
            live: []
          };

        case 'done':
          return { ...state, busy: false };

        default:
          // A new server event kind that this reducer doesn't know about yet would otherwise be
          // dropped with zero trace — silent in prod is fine, silent in dev costs hours. DEV-only
          // so it never fires for a real user.
          if (import.meta.env.DEV) {
            console.warn(`[ChatPanel] unhandled event kind: ${(ev as AgentEvent).kind}`);
          }
          return state;
      }
    }

    default:
      return state;
  }
}

/** Phases where a turn is still running — the orchestrator disables input and shows a stop button. */
export const IN_PROGRESS: Phase[] = ['planning', 'executing', 'building', 'validating', 'committing'];
