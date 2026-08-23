// The between-turns gate cards: MCP add, MCP login, tool draft, capability escalation.
//
// These are PLATFORM CHROME, and that is why they are their own file rather than inline JSX in the
// orchestrator. Every permission clause here is rendered from the enforced grant the server sent, not
// from anything the agent wrote; the agent's own words ride in a separate field and are styled
// unmistakably differently (`AssistantClaim`), because an injected agent writes a reassuring
// description exactly when it matters. Keeping them together keeps that rule reviewable in one place.
import { memo, useEffect, useRef, useState } from 'react';
import { Alert, Button, Collapse, Input } from '@/ui/atoms';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  MessageOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { continueLogin, getMcpLoginStatus } from '@/lib/chatApi';
import type { McpProposalView, McpLoginView, DraftApprovalView, CapabilityApprovalView } from '@/lib/chatTypes';

/** The awaiting-mcp-approval gate: show the CONCRETE launch spec (server-rendered, no secrets) +
 *  one masked field per needed credential, and confirm/decline. The command/url is display-only —
 *  approval sends only the credential values; the server uses its own stored draft for what runs. */
export const McpApprovalCard = memo(function McpApprovalCard({
  proposal,
  busy,
  cancelling,
  readOnly,
  onApprove,
  onReject,
  onCancel
}: {
  proposal: McpProposalView;
  busy: boolean;
  cancelling: boolean;
  /** Replay of a finished conversation — show WHAT was asked for, offer nothing to click. */
  readOnly?: boolean;
  onApprove: (secrets: Record<string, string>) => void;
  onReject: () => void;
  onCancel: () => void;
}) {
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const needed = proposal.neededCredentials ?? [];
  const launch =
    proposal.transport === 'http'
      ? proposal.url ?? ''
      : [proposal.command, ...(proposal.args ?? [])].filter(Boolean).join(' ');
  const missing = needed.some((k) => !(secrets[k]?.trim()));
  return (
    <Alert
      type="warning"
      showIcon
      style={{ margin: '8px 0' }}
      message={`AI 想添加外部 MCP 服务:${proposal.name}`}
      description={
        <div>
          <div style={{ marginBottom: 6, opacity: 0.85 }}>
            连接方式(<code>{proposal.transport}</code>)—— 请核对下面将要运行的命令后再确认:
          </div>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              background: 'rgba(0,0,0,0.05)',
              padding: 8,
              borderRadius: 4,
              margin: '0 0 8px',
              fontSize: 12
            }}
          >
            {launch}
          </pre>
          <UnsandboxedNotice can={proposal.can ?? []} />
          {!readOnly && needed.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ marginBottom: 4, opacity: 0.85 }}>需要你提供登录凭据(仅存本机,不写入对话记录):</div>
              {needed.map((k) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ minWidth: 120, fontFamily: 'monospace', fontSize: 12 }}>{k}</span>
                  <Input.Password
                    size="small"
                    placeholder={`输入 ${k}`}
                    value={secrets[k] ?? ''}
                    onChange={(e) => setSecrets((s) => ({ ...s, [k]: e.target.value }))}
                    style={{ flex: 1 }}
                  />
                </div>
              ))}
            </div>
          )}
          {readOnly ? (
            <div className="chat-actions-hint">这段对话已结束,这里不能再操作。</div>
          ) : (
            <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
              <Button type="primary" loading={busy} disabled={missing} onClick={() => onApprove(secrets)}>
                批准并连接
              </Button>
              <Button danger loading={busy} onClick={onReject}>
                拒绝
              </Button>
              <Button size="small" danger loading={cancelling} onClick={onCancel} style={{ marginLeft: 'auto' }}>
                放弃任务
              </Button>
            </div>
          )}
        </div>
      }
    />
  );
});

/** The awaiting-login gate: the agent decided it needs to log into an MCP server. Render the QR/URL
 *  the server handed back, poll its login status, and resume the agent automatically once logged in.
 *  Reuses the same generic login mechanism as the /manage 登录 button — login is LLM-decided here. */
export const McpLoginCard = memo(function McpLoginCard({
  login,
  sessionId,
  cancelling,
  onCancel
}: {
  login: McpLoginView;
  sessionId: string | null;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const [done, setDone] = useState(false);
  const resumed = useRef(false);
  useEffect(() => {
    if (done) return;
    let stop = false;
    const iv = setInterval(async () => {
      try {
        const st = await getMcpLoginStatus(login.serverId);
        if (!stop && st.loggedIn && !resumed.current) {
          resumed.current = true;
          setDone(true);
          if (sessionId) await continueLogin(sessionId); // resume the paused agent
        }
      } catch { /* keep polling */ }
    }, 2000);
    return () => { stop = true; clearInterval(iv); };
  }, [login.serverId, sessionId, done]);

  return (
    <Alert
      type="warning"
      showIcon
      style={{ margin: '8px 0' }}
      message={`需要登录:${login.serverName}`}
      description={
        <div>
          {done ? (
            <div style={{ color: '#2e7d32', padding: '8px 0' }}>✅ 已登录,正在继续…</div>
          ) : (
            <>
              {login.imageDataUri && (
                <img
                  src={login.imageDataUri}
                  alt="登录二维码"
                  style={{ width: 200, height: 200, imageRendering: 'pixelated', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 6, display: 'block', marginBottom: 8 }}
                />
              )}
              {login.url && (
                <div style={{ marginBottom: 8, wordBreak: 'break-all' }}>
                  <a href={login.url} target="_blank" rel="noreferrer">{login.url}</a>
                </div>
              )}
              <div style={{ opacity: 0.85 }}>{login.message}</div>
              {login.text && <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7, whiteSpace: 'pre-wrap' }}>{login.text}</div>}
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.6 }}>登录完成后我会自动继续(每 2 秒检测)。</div>
              <Button size="small" danger loading={cancelling} onClick={onCancel} style={{ marginTop: 8 }}>
                放弃任务
              </Button>
            </>
          )}
        </div>
      }
    />
  );
});

/** The two permission clauses at the heart of both grant cards below. `can`/`cannot` are rendered
 *  by the SERVER from its reading of the enforced grant — never something the assistant wrote —
 *  so this is styled as a structured record (icons + two columns), deliberately NOT a prose block,
 *  to keep it visually unmistakable from the assistant's own words shown alongside it. */
function GrantClauses({ can, cannot }: { can: string[]; cannot: string[] }) {
  return (
    <div className="grant-clauses">
      <div className="grant-clause-col grant-can">
        <div className="grant-clause-title"><CheckCircleOutlined /> 系统允许</div>
        {can.length > 0 ? (
          <ul>{can.map((c, i) => <li key={i}>{c}</li>)}</ul>
        ) : (
          <div className="grant-clause-empty">(无)</div>
        )}
      </div>
      <div className="grant-clause-col grant-cannot">
        <div className="grant-clause-title"><CloseCircleOutlined /> 系统禁止</div>
        {cannot.length > 0 ? (
          <ul>{cannot.map((c, i) => <li key={i}>{c}</li>)}</ul>
        ) : (
          <div className="grant-clause-empty">(无)</div>
        )}
      </div>
    </div>
  );
}

/** The counterpart to `GrantClauses` for something that is NOT contained: an external MCP server
 *  runs as a plain child process with this account's privileges. Deliberately not rendered through
 *  `GrantClauses` — that component's 系统禁止 column would show "(无)", which reads as a missing
 *  value rather than as the warning it actually is. The clauses are server-rendered; the agent
 *  proposes the server but never the words describing what saying yes to it means. */
function UnsandboxedNotice({ can }: { can: string[] }) {
  if (can.length === 0) return null;
  return (
    <div className="grant-unsandboxed">
      <div className="grant-unsandboxed-title">
        <WarningOutlined /> 这个服务不在沙箱内 · this service is not sandboxed
      </div>
      <div className="grant-unsandboxed-body">
        这是第三方程序,批准后它可以:
        <ul>{can.map((c, i) => <li key={i}>{c}</li>)}</ul>
        只在你信任该软件来源时批准。
      </div>
    </div>
  );
}

/** Something the assistant itself wrote — a tool's `description`, an escalation's `agentReason`.
 *  Rendered as a visible quote (icon + label + italic text), never left to blend into the
 *  surrounding system copy: an injected agent writes a reassuring description exactly when it
 *  matters most, so the UI has to make plain whose words these are. */
function AssistantClaim({ text }: { text: string }) {
  return (
    <div className="grant-claim">
      <div className="grant-claim-label"><MessageOutlined /> AI 是这么说的</div>
      <div className="grant-claim-text">{text}</div>
    </div>
  );
}

/** The awaiting-draft-approval gate: the assistant wrote a tool during this run and wants it
 *  enabled. No path here enables anything by default — closing or ignoring the card leaves the
 *  tool disabled; only an explicit 启用 click does. */
export const DraftApprovalCard = memo(function DraftApprovalCard({
  draft,
  busy,
  readOnly,
  onApprove,
  onReject
}: {
  draft: DraftApprovalView;
  busy: boolean;
  /** Replay of a finished conversation — the record of what was asked, with nothing to click. */
  readOnly?: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <Alert
      type="warning"
      showIcon
      style={{ margin: '8px 0' }}
      message={`AI 写了一个新工具,想要启用:${draft.title}`}
      description={
        <div>
          <AssistantClaim text={draft.description} />
          <GrantClauses can={draft.can} cannot={draft.cannot} />
          <Collapse
            ghost
            size="small"
            items={[
              {
                key: 'src',
                label: '查看代码',
                children: <pre className="grant-code">{draft.entrySource}</pre>
              }
            ]}
          />
          {readOnly ? (
            <div className="chat-actions-hint">这段对话已结束,这里不能再操作。</div>
          ) : (
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <Button type="primary" loading={busy} onClick={onApprove}>
                启用 Enable
              </Button>
              <Button danger loading={busy} onClick={onReject}>
                不用 No thanks
              </Button>
            </div>
          )}
        </div>
      }
    />
  );
});

/** The awaiting-capability-approval gate: a capability call was refused mid-run and the agent is
 *  asking the human to widen (or confirm) what it can do. Three explicit outcomes, no default —
 *  仅此一次 grants nothing beyond this one call, 一直允许 persists the grant, 不允许 refuses. */
export const CapabilityApprovalCard = memo(function CapabilityApprovalCard({
  capability,
  busy,
  readOnly,
  onAllowOnce,
  onAllowAlways,
  onDeny
}: {
  capability: CapabilityApprovalView;
  busy: boolean;
  /** Replay of a finished conversation — the record of what was asked, with nothing to click. */
  readOnly?: boolean;
  onAllowOnce: () => void;
  onAllowAlways: () => void;
  onDeny: () => void;
}) {
  return (
    <Alert
      type="warning"
      showIcon
      style={{ margin: '8px 0' }}
      message={`AI 请求了一项被拒绝的权限:${capability.id}`}
      description={
        <div>
          <div style={{ marginBottom: 6, fontSize: 12, opacity: 0.85 }}>
            请求来自:<code>{capability.origin}</code> · 当前状态:<code>{capability.state}</code>
          </div>
          <AssistantClaim text={capability.agentReason} />
          <GrantClauses can={capability.can} cannot={capability.cannot} />
          {readOnly ? (
            <div className="chat-actions-hint">这段对话已结束,这里不能再操作。</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              <Button type="primary" loading={busy} onClick={onAllowOnce}>
                仅此一次 Allow once
              </Button>
              <Button loading={busy} onClick={onAllowAlways}>
                一直允许 Always allow
              </Button>
              <Button danger loading={busy} onClick={onDeny}>
                不允许 Deny
              </Button>
            </div>
          )}
        </div>
      }
    />
  );
});
