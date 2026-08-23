import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Alert, Button, IconButton, Input, Spin, Switch, Tag, Tooltip } from '@/ui/atoms';
import {
  SendOutlined,
  RobotOutlined,
  CheckCircleFilled,
  StopOutlined,
  PaperClipOutlined,
  PlusOutlined,
  HistoryOutlined
} from '@ant-design/icons';
import { PlanActions, DiffReview } from './ChatReview';
import { ChatRating } from './ChatRating';
import { ChatHistory } from './ChatHistory';
import {
  startChat,
  openStream,
  approvePlan,
  rejectPlan,
  approveDiff,
  rejectDiff,
  refinePlan,
  refineDiff,
  respondInput,
  approveMcp,
  rejectMcp,
  approveDraft,
  rejectDraft,
  allowCapability,
  denyCapability,
  getActiveSession,
  cancelChat,
  uploadFiles,
  getChatHistory,
  getConversation,
  type ConversationRow
} from '@/lib/chatApi';
import {
  type AgentEvent,
  type UploadedFile,
  PHASE_LABELS
} from '@/lib/chatTypes';
import { formatFileSize } from '@/lib/format';
import {
  byIndex, CHAT_STARTERS, DRAFT_KEY, hasContent, IN_PROGRESS, initialState, reducer, SESSION_KEY,
} from './chatReducer';
import { PhaseSteps, UsageLine } from './PhaseSteps';
import { CapabilityApprovalCard, DraftApprovalCard, McpApprovalCard, McpLoginCard } from './GateCards';
import { SegmentList, TranscriptRow } from './Transcript';


export function ChatPanel({
  prefill,
  prefillNonce,
  onOpenRecord,
  onCommitted
}: {
  prefill?: string;
  prefillNonce?: number;
  /** Open a record file in the reading column — what a rendered block's `openRecord` button does. */
  onOpenRecord?: (path: string) => void;
  /** A turn's changes were committed to the data repo. The host re-reads whatever the agent may
   *  have changed (the site's page list) — a page it just wrote must not need a manual reload. */
  onCommitted?: () => void;
}) {
  const [state, dispatch] = useReducer(reducer, initialState);
  // Restore any unsent draft (closing the drawer unmounts this component).
  const [draft, setDraft] = useState(() => {
    try { return localStorage.getItem(DRAFT_KEY) ?? ''; } catch { return ''; }
  });
  const [cancelling, setCancelling] = useState(false);
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  // 系统模式: the agent edits the app's OWN UI code (src/client), builds it, and the
  // approved change ships on the next refresh. Off = normal planning on the data workspace.
  const [systemMode, setSystemMode] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- conversation history ---------------------------------------------------------
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<ConversationRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  // The conversation being SHOWN. Null while on a live session that has no id yet.
  const [conversationId, setConversationId] = useState<string | null>(null);
  // True when the transcript is a replay of a finished conversation rather than a live session.
  // Gate ACTIONS render only when false — the in-memory session that could act on them is gone,
  // and a button that silently does nothing is worse than a finished decision.
  const [historical, setHistorical] = useState(false);

  // Highest SSE frame seq applied — reset to -1 whenever a fresh stream opens (both open from the
  // server's log at seq 0). Guards against a re-delivered frame doubling token/cost + transcript if a
  // reconnect ever replays past what Last-Event-ID already covered.
  const lastSeqRef = useRef(-1);
  // Kept in a ref so onEvent stays referentially stable — it feeds the SSE subscription, and a
  // handler that changed identity would tear the stream down and reopen it on every host re-render.
  const committedRef = useRef(onCommitted);
  committedRef.current = onCommitted;
  // Dispatch an event + drop the persisted session id once it finishes.
  const onEvent = useCallback((ev: AgentEvent, seq: number) => {
    if (seq >= 0 && seq <= lastSeqRef.current) return;   // already applied — skip replay
    if (seq >= 0) lastSeqRef.current = seq;
    if (ev.kind === 'done') localStorage.removeItem(SESSION_KEY);
    // The commit is the moment the working tree became the committed tree, so it's the moment the
    // host's view of the data folder is stale.
    if (ev.kind === 'phase' && ev.phase === 'committed') committedRef.current?.();
    dispatch({ type: 'event', ev });
  }, []);

  const closeRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track whether the transcript is scrolled to the bottom so streaming updates don't yank the user
  // back when they've scrolled up to re-read; a "jump to latest" button appears when they have.
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const onScrollList = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = near;
    setShowJump(!near); // show the jump button only when scrolled away from the bottom
  }, []);
  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  }, []);

  // Seed the input when an action routes here (user reviews, then sends).
  useEffect(() => {
    if (prefill) setDraft(prefill);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillNonce]);

  // Persist the unsent draft (cleared when send() sets it to '').
  useEffect(() => {
    try { if (draft) localStorage.setItem(DRAFT_KEY, draft); else localStorage.removeItem(DRAFT_KEY); } catch { /* storage disabled */ }
  }, [draft]);

  // Attach this panel to an existing server session: rehydrate from its replayed event log + open its
  // stream. Used on mount AND to recover from a BUSY reply (a live session we lost track of). We do NOT
  // pass an onError that clears SESSION_KEY — EventSource fires onerror on every transient drop and
  // auto-reconnects, so clearing here would strand a live (e.g. awaiting-input) session; only a real
  // 'done' clears it (in onEvent).
  const attachTo = useCallback((id: string) => {
    try { localStorage.setItem(SESSION_KEY, id); } catch { /* storage disabled */ }
    dispatch({ type: 'rehydrate', sessionId: id });
    lastSeqRef.current = -1;   // fresh stream replays from seq 0
    closeRef.current?.();
    closeRef.current = openStream(id, onEvent);
  }, [onEvent]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try { setHistory((await getChatHistory()).conversations ?? []); }
    catch { setHistory([]); }
    finally { setHistoryLoading(false); }
  }, []);

  // Replay a stored conversation through the SAME reducer the live stream feeds. One renderer:
  // blocks, tool rows, notices and gate cards all come back through the code that already draws
  // them, so a history view cannot drift from the live one.
  const openConversation = useCallback(async (id: string) => {
    setShowHistory(false);
    closeRef.current?.();            // detach any live stream first — a late frame must not interleave
    closeRef.current = null;
    // Nothing live is being shown any more; a stale id here would only 404 the stream on reload.
    try { localStorage.removeItem(SESSION_KEY); } catch { /* storage disabled */ }
    dispatch({ type: 'rehydrate', sessionId: '' });
    setConversationId(id);
    setHistorical(true);
    try {
      const convo = await getConversation(id);
      for (const ev of convo.events) dispatch({ type: 'event', ev });
    } catch {
      dispatch({ type: 'event', ev: { kind: 'error', text: '打不开这段对话。' } });
    }
  }, []);

  // Start over on a blank, live slate — the transcript is the app's main surface, so there has to be
  // a way back to "nothing in progress" that isn't a page reload.
  const newConversation = useCallback(() => {
    setShowHistory(false);
    closeRef.current?.();
    closeRef.current = null;
    try { localStorage.removeItem(SESSION_KEY); } catch { /* storage disabled */ }
    dispatch({ type: 'rehydrate', sessionId: '' });
    setConversationId(null);
    setHistorical(false);
  }, []);

  const toggleHistory = useCallback(() => {
    setShowHistory((on) => {
      if (!on) void loadHistory();
      return !on;
    });
  }, [loadHistory]);

  // Reconnect to an in-flight session after a reload/reopen — a live session always wins over
  // history. The SERVER is the authority on what is live (one app-wide agent lease): a saved id can
  // be a session a restart already failed, whose stream would only 404. With nothing live, fall
  // through to the newest stored conversation so reopening the app looks like you left it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let id: string | null = null;
      try {
        const a = await getActiveSession();
        if (a.active && a.id) id = a.id;
      } catch {
        id = localStorage.getItem(SESSION_KEY);   // offline — trust the last id we saw
      }
      if (cancelled) return;
      if (id) { attachTo(id); return; }
      try { localStorage.removeItem(SESSION_KEY); } catch { /* storage disabled */ }
      try {
        const rows = (await getChatHistory()).conversations ?? [];
        if (cancelled) return;
        setHistory(rows);
        if (rows.length > 0) await openConversation(rows[0].id);
      } catch { /* no history to show */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll to newest content — but only when the user is already near the bottom, so scrolling
  // up to re-read mid-stream isn't yanked back (the jump button handles the return).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [state.items, state.live, state.review, state.phase]);

  useEffect(() => () => closeRef.current?.(), []);

  // `inFlow` = a session is ongoing (locks the mode switch). `active` = the AI is
  // actively working (input disabled; use 停止). At the two approval gates AND when the
  // agent paused for input, the input is ENABLED so the user can answer / request adjustments.
  // A replayed conversation is never in flow, whatever phase it ended in: an interrupted turn is
  // marked errored in the store but its last STORED phase event can still say 'planning', and a
  // finished transcript must not disable the composer or offer a 停止 button.
  const inFlow =
    !historical &&
    (IN_PROGRESS.includes(state.phase) ||
      state.phase === 'awaiting-plan-approval' ||
      state.phase === 'awaiting-diff-approval' ||
      state.phase === 'awaiting-input');
  const active = !historical && IN_PROGRESS.includes(state.phase);
  // A fresh turn can be sent with text OR attachments alone (attachments-only
  // falls back to a default instruction in send()).
  const canSend =
    !active && !state.busy && !uploading && (draft.trim().length > 0 || attachments.length > 0);

  // Upload picked files → append their server references to the pending list.
  const pickFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const uploaded = await uploadFiles(Array.from(files));
      setAttachments((prev) => [...prev, ...uploaded]);
    } catch (err: any) {
      dispatch({ type: 'event', ev: { kind: 'error', text: err?.message ?? '上传失败' } });
    } finally {
      setUploading(false);
    }
  }, []);

  const removeAttachment = useCallback((relPath: string) => {
    setAttachments((prev) => prev.filter((a) => a.relPath !== relPath));
  }, []);

  // Reply to a paused agent — free text OR a clicked OPTION. Optimistically re-enter executing (the
  // SSE phase event confirms it); same session, so the stream stays open and the agent resumes.
  const replyInput = useCallback(async (message: string) => {
    const { sessionId } = state;
    const text = message.trim();
    if (!sessionId || !text) return;
    dispatch({ type: 'refine', phase: 'executing', message: text });
    setDraft('');
    try {
      await respondInput(sessionId, text);
    } catch (err: any) {
      dispatch({ type: 'event', ev: { kind: 'error', text: err?.message ?? '发送失败' } });
    }
  }, [state]);

  // `override` lets a rendered Button's `send` action reuse this EXACT path (gate refine / input
  // reply / fresh turn, in that order) instead of getting a private route into the agent.
  const send = useCallback(async (override?: string) => {
    const message = (override ?? draft).trim();
    const { phase, sessionId } = state;
    try {
      // At a gate: talk back instead of starting a new turn — the agent revises
      // and returns to the gate (same session, stream stays open). A typed
      // message is required here; attachments aren't supported at gates yet.
      if (phase === 'awaiting-plan-approval' && sessionId) {
        if (!message) return;
        dispatch({ type: 'refine', phase: 'planning', message });
        setDraft('');
        await refinePlan(sessionId, message);
        return;
      }
      if (phase === 'awaiting-diff-approval' && sessionId) {
        if (!message) return;
        dispatch({ type: 'refine', phase: 'executing', message });
        setDraft('');
        await refineDiff(sessionId, message);
        return;
      }
      // Agent paused for a decision: reply resumes the SAME session and continues executing.
      if (phase === 'awaiting-input' && sessionId) {
        if (!message) return;
        await replyInput(message);
        return;
      }
      // Otherwise (idle / terminal): a fresh turn on a new session. Allow an
      // attachments-only send with a default instruction so the backend (which
      // requires a message) still gets one.
      if (!message && attachments.length === 0) return;
      const outgoing = message || '请阅读我上传的附件,并据此帮我规划 / 填写行程。';
      closeRef.current?.();
      // Typing into an opened past conversation continues THAT conversation: the new turn joins it
      // and its prompt carries that conversation's rebuilt context. Either way we are live again.
      const { id } = await startChat(
        outgoing, attachments, systemMode ? 'system' : 'plan', conversationId ?? undefined
      );
      setHistorical(false);
      localStorage.setItem(SESSION_KEY, id);
      dispatch({ type: 'reset', sessionId: id, message: outgoing });
      setDraft('');
      setAttachments([]);
      lastSeqRef.current = -1;   // fresh session/stream starts at seq 0
      closeRef.current = openStream(id, onEvent);
    } catch (err: any) {
      const text = err?.message ?? '发送失败';
      // BUSY: a session is already live (commonly one paused at awaiting-input). Re-attach to it so the
      // user lands on it and can reply or 放弃任务 — instead of a dead-end "task in progress" error.
      if (/已有一个任务|BUSY/.test(text)) {
        try {
          const a = await getActiveSession();
          if (a.active && a.id) { attachTo(a.id); return; }
        } catch { /* fall through to surfacing the error */ }
      }
      dispatch({ type: 'event', ev: { kind: 'error', text } });
    }
  }, [draft, onEvent, state, attachments, systemMode, replyInput, attachTo, conversationId]);

  // `send` closes over draft + state, so it changes on every keystroke and every event. Route the
  // rendered buttons through a ref so the handler they receive is REFERENTIALLY STABLE — otherwise
  // TranscriptRow's memo is defeated and every finished row re-parses its markdown on each delta.
  const sendRef = useRef(send);
  sendRef.current = send;
  const sendText = useCallback((text: string) => {
    setDraft(text);            // the message is visible in the composer, exactly as if typed
    void sendRef.current(text);
  }, []);

  const openRecordRef = useRef(onOpenRecord);
  openRecordRef.current = onOpenRecord;
  const openRecordStable = useCallback((path: string) => openRecordRef.current?.(path), []);
  // Stay undefined when the host gave us no way to open a record — a Button renders itself inert
  // rather than looking clickable and doing nothing.
  const openRecord = onOpenRecord ? openRecordStable : undefined;

  const act = useCallback(
    async (fn: (id: string) => Promise<unknown>) => {
      if (!state.sessionId) return;
      dispatch({ type: 'busy', value: true });
      try {
        await fn(state.sessionId);
      } catch (err: any) {
        dispatch({ type: 'event', ev: { kind: 'error', text: err?.message ?? '操作失败' } });
        dispatch({ type: 'busy', value: false });
      }
    },
    [state.sessionId]
  );

  const cancel = useCallback(async () => {
    if (!state.sessionId) return;
    setCancelling(true);
    try {
      await cancelChat(state.sessionId);
    } catch (err: any) {
      dispatch({ type: 'event', ev: { kind: 'error', text: err?.message ?? '停止失败' } });
    }
  }, [state.sessionId]);

  // Reset the local "cancelling" flag once the task leaves the active state.
  useEffect(() => {
    if (!IN_PROGRESS.includes(state.phase)) setCancelling(false);
  }, [state.phase]);

  // Safety net: `busy` is normally cleared by the confirming `phase`/`done` SSE event (which now
  // reliably arrives — the stream resumes on reconnect). But a permanently-stuck gate button is worse
  // than a re-enabled one, so force-clear after a grace period if no event ever lands. The phase-event
  // path clears busy first, and this effect's cleanup cancels the timer, so it only fires on a true stall.
  useEffect(() => {
    if (!state.busy) return;
    const t = window.setTimeout(() => dispatch({ type: 'busy', value: false }), 30000);
    return () => window.clearTimeout(t);
  }, [state.busy]);

  return (
    <div className="chat-panel">
      <div className="chat-head">
        <RobotOutlined style={{ color: 'var(--accent)' }} />
        <span className="chat-title">Claude 助手</span>
        <div className="chat-head-actions">
          {state.phase !== 'idle' && (
            <Tag color={active ? 'processing' : undefined}>
              {active && <Spin size="small" style={{ marginRight: 6 }} />}
              {PHASE_LABELS[state.phase]}
            </Tag>
          )}
          {active && (
            <Button
              danger
              size="small"
              icon={<StopOutlined />}
              loading={cancelling}
              onClick={() => void cancel()}
            >
              停止
            </Button>
          )}
          <IconButton
            icon={<PlusOutlined />}
            title="新对话"
            ariaLabel="新对话"
            disabled={inFlow}
            onClick={newConversation}
          />
          <IconButton
            icon={<HistoryOutlined />}
            title="历史对话"
            ariaLabel="历史对话"
            className={showHistory ? 'is-on' : ''}
            onClick={toggleHistory}
          />
        </div>
      </div>

      {showHistory ? (
        <div className="chat-scroll">
          <ChatHistory
            rows={history}
            loading={historyLoading}
            activeId={conversationId}
            onOpen={openConversation}
          />
        </div>
      ) : (
      <>
      <PhaseSteps phase={state.phase} />
      <UsageLine usage={state.usage} live={state.liveUsage} />

      {showJump && (
        <button className="chat-jump" onClick={jumpToLatest} aria-label="滚动到最新">
          ↓ 最新
        </button>
      )}
      <div className="chat-scroll" ref={scrollRef} onScroll={onScrollList} role="log" aria-live="polite" aria-relevant="additions text">
        {historical && (
          <div className="chat-historical-note">
            正在查看历史对话 · 继续输入会开始新的一轮
          </div>
        )}

        {state.items.length === 0 && state.phase === 'idle' && (
          <div className="chat-empty">
            <p>用大白话告诉我要改什么,点一条试试:</p>
            <ul className="chat-starters">
              {CHAT_STARTERS.map((s) => (
                <li key={s}>
                  <button type="button" onClick={() => setDraft(s)}>{s}</button>
                </li>
              ))}
            </ul>
            <p className="chat-empty-note">
              我会先按家庭规则拟一份计划给你看 → 你批准 → 我改文件 → 你审改动 → 自动提交。
              每个审阅环节,你都可以直接在下方输入框回话补充或提要求,我会据此修订。
            </p>
          </div>
        )}

        {state.items.map((it) => (
          <TranscriptRow key={it.id} item={it} onSend={sendText} onOpenRecord={openRecord} />
        ))}

        {hasContent(state.live) && (
          <div className="chat-msg assistant">
            <SegmentList segments={byIndex(state.live)} onSend={sendText} onOpenRecord={openRecord} />
          </div>
        )}

        {/* Gate ACTIONS are live-only. On a replay the session that could act on them is gone (a
            restart has already marked it errored), and a button that silently does nothing is the
            worst of the options. The card CONTENT — diffs, specs, grants — still renders. */}
        {!historical && state.phase === 'awaiting-plan-approval' && (
          <PlanActions
            busy={state.busy}
            onApprove={() => act(approvePlan)}
            onReject={() => act(rejectPlan)}
          />
        )}

        {state.phase === 'awaiting-diff-approval' && state.review && (
          <DiffReview
            review={state.review}
            busy={state.busy}
            readOnly={historical}
            onApprove={() => act(approveDiff)}
            onReject={() => act(rejectDiff)}
          />
        )}

        {state.phase === 'awaiting-input' && (
          <Alert
            type="info"
            showIcon
            style={{ margin: '8px 0' }}
            message={state.inputOptions.length > 0 ? 'AI 需要你的选择 / 回复才能继续' : 'AI 需要你的回复才能继续'}
            description={
              <div>
                {state.inputQuestion && (
                  <div style={{ marginBottom: 8, whiteSpace: 'pre-wrap' }}>{state.inputQuestion}</div>
                )}
                {!historical && state.inputOptions.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                    {state.inputOptions.map((opt, i) => (
                      <Button key={i} size="small" type="primary" ghost onClick={() => void replyInput(opt)}>
                        {opt}
                      </Button>
                    ))}
                  </div>
                )}
                <span style={{ opacity: 0.75 }}>
                  {historical
                    ? '这段对话停在这里没有再继续。'
                    : state.inputOptions.length > 0
                      ? '点一个选项,或在下方输入框回复。'
                      : '在下方输入框回复,我会带着你的答复继续这次任务。'}
                </span>
                {!historical && (
                  <Button
                    size="small"
                    danger
                    loading={cancelling}
                    onClick={() => void cancel()}
                    style={{ marginLeft: 8 }}
                  >
                    放弃任务
                  </Button>
                )}
              </div>
            }
          />
        )}

        {state.phase === 'awaiting-mcp-approval' && state.mcpProposal && (
          <McpApprovalCard
            proposal={state.mcpProposal}
            busy={state.busy}
            cancelling={cancelling}
            readOnly={historical}
            onApprove={(secrets) => act((id) => approveMcp(id, secrets))}
            onReject={() => act(rejectMcp)}
            onCancel={() => void cancel()}
          />
        )}

        {/* Live-only by nature: this card POLLS the login status and resumes the agent when it
            flips. On a replay there is no agent to resume and the QR it showed has long expired. */}
        {!historical && state.phase === 'awaiting-login' && state.mcpLogin && (
          <McpLoginCard
            login={state.mcpLogin}
            sessionId={state.sessionId}
            cancelling={cancelling}
            onCancel={() => void cancel()}
          />
        )}

        {state.phase === 'awaiting-draft-approval' && state.draftApproval && (
          <DraftApprovalCard
            draft={state.draftApproval}
            busy={state.busy}
            readOnly={historical}
            onApprove={() => act(approveDraft)}
            onReject={() => act(rejectDraft)}
          />
        )}

        {state.phase === 'awaiting-capability-approval' && state.capabilityApproval && (
          <CapabilityApprovalCard
            capability={state.capabilityApproval}
            busy={state.busy}
            readOnly={historical}
            onAllowOnce={() => act((id) => allowCapability(id, false))}
            onAllowAlways={() => act((id) => allowCapability(id, true))}
            onDeny={() => act(denyCapability)}
          />
        )}

        {state.phase === 'committed' && (
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleFilled />}
            style={{ margin: '8px 0' }}
            message={`已提交 ${state.commitSha ?? ''}`}
            description="改动已写入仓库,页面内容会自动刷新。"
          />
        )}

        {state.phase === 'rejected' && (
          <Alert type="info" showIcon style={{ margin: '8px 0' }} message="已取消,无改动落库。" />
        )}

        {state.phase === 'cancelled' && (
          <Alert
            type="warning"
            showIcon
            style={{ margin: '8px 0' }}
            message="已强制停止,本次改动已还原。"
          />
        )}

        {state.error && (
          <Alert type="error" showIcon style={{ margin: '8px 0' }} message={state.error} />
        )}

        {/* key on the session so a new conversation gets a fresh rating widget (local sent/rating
            state would otherwise persist and lock out rating every turn after the first). */}
        <ChatRating key={state.sessionId ?? 'none'} sessionId={state.sessionId} phase={state.phase} />
      </div>
      </>
      )}

      {!showHistory && (
      <div className="chat-composer">
        <div className="chat-mode-row">
          <Tooltip title="开启后,本次对话改的是 Gatherlight 界面本身(src/client 代码),改完自动构建验证,构建不过不能提交;批准后刷新即生效。">
            <label className={`chat-mode-label ${systemMode ? 'on' : ''}`}>
              <Switch size="small" checked={systemMode} disabled={inFlow} onChange={setSystemMode} />
              系统模式 · 改界面
            </label>
          </Tooltip>
          {systemMode && <span className="chat-mode-hint">AI 将编辑前端代码并自检构建</span>}
        </div>

        {attachments.length > 0 && (
          <div className="chat-attachments">
            {attachments.map((a) => (
              <Tag
                key={a.relPath}
                closable
                icon={<PaperClipOutlined />}
                onClose={(e) => {
                  e.preventDefault();
                  removeAttachment(a.relPath);
                }}
              >
                <span className="chat-attach-name">{a.name}</span>
                <span className="chat-attach-size">{formatFileSize(a.size)}</span>
              </Tag>
            ))}
          </div>
        )}

        <div className="chat-input">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/*"
            multiple
            hidden
            onChange={(e) => {
              void pickFiles(e.target.files);
              e.target.value = ''; // allow re-picking the same file
            }}
          />
          <Tooltip title="上传 PDF / 图片附件 — 我会先读取内容再规划">
            <span>
              <IconButton
                className="chat-attach-btn"
                icon={uploading ? <Spin size="small" /> : <PaperClipOutlined />}
                ariaLabel="上传附件"
                disabled={inFlow || uploading}
                onClick={() => fileInputRef.current?.click()}
              />
            </span>
          </Tooltip>
          <Input.TextArea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              active
                ? '任务进行中…(可点「停止」中断)'
                : state.phase === 'awaiting-plan-approval'
                  ? '可批准,或在此回答问题 / 补充信息 → 我据此改计划'
                  : state.phase === 'awaiting-diff-approval'
                    ? '可批准,或在此说明要怎么调整 → 我据此改文件'
                    : state.phase === 'awaiting-input'
                      ? '回答 AI 的问题 / 补充信息 → 我带着你的答复继续'
                      : '要改什么?(Enter 发送,Shift+Enter 换行)'
            }
            autoSize={{ minRows: 2, maxRows: 8 }}
            disabled={active}
            onPressEnter={(e) => {
              if (!e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            disabled={!canSend}
            onClick={() => void send()}
          />
        </div>
      </div>
      )}
    </div>
  );
}

/** The ordered segments of one assistant turn — prose rendered as markdown, blocks as trees. */
