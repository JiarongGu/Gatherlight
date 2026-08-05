import { useState } from 'react';
import { Button, Space, Tag, Alert, Collapse, DiffBlock } from '@/ui/atoms';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  WarningOutlined,
  FileOutlined
} from '@ant-design/icons';
import { UiTree } from '@/ui/blocks/UiTree';
import type { ReviewPayload, DiffFile, PageDiffView } from '@/lib/chatTypes';

const STATUS_COLOR: Record<DiffFile['status'], string> = {
  added: 'green',
  modified: 'blue',
  deleted: 'red'
};
const STATUS_LABEL: Record<DiffFile['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除'
};

// --- Gate 1: plan approval -------------------------------------------------

export function PlanActions({
  busy,
  onApprove,
  onReject
}: {
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="chat-actions">
      <div className="chat-actions-hint">审阅上面的计划 — 批准后我才会动文件。</div>
      <Space>
        <Button
          type="primary"
          icon={<CheckCircleOutlined />}
          loading={busy}
          onClick={onApprove}
        >
          批准并执行
        </Button>
        <Button danger icon={<CloseCircleOutlined />} disabled={busy} onClick={onReject}>
          拒绝
        </Button>
      </Space>
    </div>
  );
}

// --- Gate 2: diff review ---------------------------------------------------

function FileDiff({ file }: { file: DiffFile }) {
  return (
    <div className="diff-file">
      <div className="diff-file-head">
        <Tag color={STATUS_COLOR[file.status]}>{STATUS_LABEL[file.status]}</Tag>
        <FileOutlined style={{ color: 'var(--muted)' }} />
        <code className="diff-file-path">{file.path}</code>
      </div>
      <DiffBlock diff={file.diff} />
    </div>
  );
}

/** A changed page, reviewed by looking at it. The raw diff stays one disclosure away — the render is
 *  the review, the diff is the appeal. No `onSend` / `onOpenRecord` is passed: a preview's buttons are
 *  inert, which is correct — you are approving the page, not operating it. */
function PageChange({ page, diff }: { page: PageDiffView; diff?: DiffFile }) {
  return (
    <div className="page-change">
      <div className="page-change-head">
        <Tag color={page.status === 'ready' ? 'blue' : page.status === 'deleted' ? 'default' : 'red'}>
          {page.status === 'ready' ? '页面' : page.status === 'deleted' ? '删除页面' : '无法显示'}
        </Tag>
        <span className="page-change-title">{page.title}</span>
        <code className="diff-file-path">{page.path}</code>
      </div>
      {page.summary && <div className="page-change-summary">{page.summary}</div>}
      {page.status === 'ready' && page.root && (
        <div className="page-change-preview"><UiTree node={page.root} /></div>
      )}
      {page.status === 'invalid' && (
        <Alert type="warning" showIcon message="这个页面无法显示,不能提交" description={page.reason} />
      )}
      {diff && (
        <Collapse
          ghost
          size="small"
          items={[{ key: 'd', label: '查看原始差异', children: <DiffBlock diff={diff.diff} /> }]}
        />
      )}
    </div>
  );
}

export function DiffReview({
  review,
  busy,
  readOnly,
  onApprove,
  onReject
}: {
  review: ReviewPayload;
  busy: boolean;
  /** Replaying a finished conversation: the diffs are still the record worth reading, but the
   *  session that could approve them is gone — so the actions are not offered at all. */
  readOnly?: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  // A page file is reviewed as a RENDERED page, not as a diff — so it comes out of the content group
  // and into its own, with the diff itself one disclosure away.
  const pages = review.pages ?? [];
  const pagePaths = new Set(pages.map((p) => p.path));
  const contentFiles = review.files.filter((f) => !f.isClaudeInfra && !pagePaths.has(f.path));
  const claudeFiles = review.files.filter((f) => f.isClaudeInfra);
  const validation = review.validation;

  // .claude/ edits require a separate explicit acknowledgement before commit.
  const [ackClaude, setAckClaude] = useState(false);
  const needsAck = review.hasClaudeInfra;
  const buildFailed = !!review.build && !review.build.ok;
  // A page that would not render cannot be committed — the server refuses it too; this is the same
  // rule made visible, so the button is never dead without a reason.
  const invalidPages = pages.filter((p) => p.status === 'invalid');
  const hasInvalidPage = invalidPages.length > 0;
  const canApprove = !busy && (!needsAck || ackClaude) && !buildFailed && !hasInvalidPage;

  return (
    <div className="chat-review">
      <div className="chat-actions-hint">
        {readOnly ? '这次对话提出的改动(历史记录,不能再操作):' : '审阅以下改动 — 批准后将提交,拒绝则还原工作区。'}
      </div>

      {review.build && (
        <Alert
          type={review.build.ok ? 'success' : 'error'}
          showIcon
          style={{ marginBottom: 10 }}
          message={review.build.ok ? '构建通过 ✓' : '构建未通过 — 不能提交'}
          description={
            review.build.ok ? undefined : (
              <Collapse
                ghost
                size="small"
                defaultActiveKey={['b']}
                items={[
                  {
                    key: 'b',
                    label: '查看构建错误',
                    children: <pre className="validation-report">{review.build.output}</pre>
                  }
                ]}
              />
            )
          }
        />
      )}

      {pages.length > 0 && (
        <div className="diff-group">
          <div className="diff-group-title">页面改动 ({pages.length})</div>
          {pages.map((p) => (
            <PageChange key={p.path} page={p} diff={review.files.find((f) => f.path === p.path)} />
          ))}
        </div>
      )}

      {contentFiles.length > 0 && (
        <div className="diff-group">
          <div className="diff-group-title">内容改动 ({contentFiles.length})</div>
          {contentFiles.map((f) => (
            <FileDiff key={f.path} file={f} />
          ))}
        </div>
      )}

      {claudeFiles.length > 0 && (
        <div className="diff-group diff-group-claude">
          <div className="diff-group-title">
            <WarningOutlined style={{ color: 'var(--highlight)' }} /> 智库变更 (.claude/) —
            需额外确认 ({claudeFiles.length})
          </div>

          {validation && (
            <Alert
              type={validation.ok ? 'success' : 'warning'}
              showIcon
              style={{ marginBottom: 10 }}
              message={validation.ok ? '自动校验通过' : '自动校验未通过 — 请仔细检查'}
              description={
                <Collapse
                  ghost
                  size="small"
                  items={[
                    {
                      key: 'r',
                      label: '查看校验报告',
                      children: <pre className="validation-report">{validation.report}</pre>
                    }
                  ]}
                />
              }
            />
          )}

          {claudeFiles.map((f) => (
            <FileDiff key={f.path} file={f} />
          ))}

          {!readOnly && (
            <label className="claude-ack">
              <input
                type="checkbox"
                checked={ackClaude}
                onChange={(e) => setAckClaude(e.target.checked)}
              />
              我已检查上述智库(.claude/)改动,确认无误。
            </label>
          )}
        </div>
      )}

      {!readOnly && hasInvalidPage && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message="不能提交 — 有页面无法显示"
          description={`${invalidPages.map((p) => p.path).join('、')} 不是一个能显示的页面,提交会让它对家人来说是一片空白。让 AI 修正后再批准。`}
        />
      )}

      {!readOnly && (
        <div className="chat-actions">
          <Space>
            <Button
              type="primary"
              icon={<CheckCircleOutlined />}
              loading={busy}
              disabled={!canApprove}
              onClick={onApprove}
            >
              批准并提交
            </Button>
            <Button
              danger
              icon={<CloseCircleOutlined />}
              disabled={busy}
              onClick={onReject}
            >
              拒绝并还原
            </Button>
          </Space>
        </div>
      )}
    </div>
  );
}
