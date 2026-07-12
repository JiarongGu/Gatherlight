import { useState } from 'react';
import { Button, Space, Tag, Alert, Collapse, DiffBlock } from '@/shared/components/visual';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  WarningOutlined,
  FileOutlined
} from '@ant-design/icons';
import type { ReviewPayload, DiffFile } from '@/lib/chatTypes';

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

export function DiffReview({
  review,
  busy,
  onApprove,
  onReject
}: {
  review: ReviewPayload;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const contentFiles = review.files.filter((f) => !f.isClaudeInfra);
  const claudeFiles = review.files.filter((f) => f.isClaudeInfra);
  const validation = review.validation;

  // .claude/ edits require a separate explicit acknowledgement before commit.
  const [ackClaude, setAckClaude] = useState(false);
  const needsAck = review.hasClaudeInfra;
  const buildFailed = !!review.build && !review.build.ok;
  const canApprove = !busy && (!needsAck || ackClaude) && !buildFailed;

  return (
    <div className="chat-review">
      <div className="chat-actions-hint">
        审阅以下改动 — 批准后将提交,拒绝则还原工作区。
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

          <label className="claude-ack">
            <input
              type="checkbox"
              checked={ackClaude}
              onChange={(e) => setAckClaude(e.target.checked)}
            />
            我已检查上述智库(.claude/)改动,确认无误。
          </label>
        </div>
      )}

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
    </div>
  );
}
