import { useState } from 'react';
import { Dropdown, Modal, Input, App, type MenuProps } from '@/ui/atoms';
import {
  MoreOutlined,
  EditOutlined,
  TagOutlined,
  CopyOutlined,
  DeleteOutlined,
  RobotOutlined
} from '@ant-design/icons';
import { deleteEntries, retitlePlan, renamePlan } from '@/lib/actionsApi';

export type ActionTarget =
  | { kind: 'file'; path: string; title: string }
  | {
      kind: 'trip';
      slug: string;
      displayName: string;
      tripPath: string;
      tripTitle: string;
      deletePaths: string[]; // .md files to remove
      visaDir?: string; // plans/visa/<slug> if present
    };

interface Props {
  target: ActionTarget;
  /** Tell the parent what changed so it can navigate away from a deleted/renamed active file. */
  onAfterAction: (info: { removed?: string[]; renamed?: { from: string; to: string } }) => void;
  /** Route an advanced operation to the chat assistant (prefilled message). */
  onAskAI: (message: string) => void;
  className?: string;
}

export function PlanActionsMenu({ target, onAfterAction, onAskAI, className }: Props) {
  const { message } = App.useApp();
  const [mode, setMode] = useState<null | 'retitle' | 'rename' | 'delete'>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const open = (m: 'retitle' | 'rename' | 'delete') => {
    if (m === 'retitle') setValue(target.kind === 'file' ? target.title : target.tripTitle);
    else if (m === 'rename' && target.kind === 'file') {
      setValue(target.path.split('/').pop()!.replace(/\.md$/, ''));
    } else setValue('');
    setMode(m);
  };

  const items: MenuProps['items'] =
    target.kind === 'file'
      ? [
          { key: 'retitle', icon: <TagOutlined />, label: '改标题' },
          { key: 'rename', icon: <EditOutlined />, label: '重命名文件' },
          { type: 'divider' },
          { key: 'delete', icon: <DeleteOutlined />, label: '删除', danger: true }
        ]
      : [
          { key: 'retitle', icon: <TagOutlined />, label: '改标题' },
          { key: 'duplicate', icon: <CopyOutlined />, label: '复制为新方案(AI)' },
          { key: 'rename-ai', icon: <RobotOutlined />, label: '重命名 / 改日期(AI)' },
          { type: 'divider' },
          { key: 'delete', icon: <DeleteOutlined />, label: '删除整个旅行', danger: true }
        ];

  const onMenuClick: MenuProps['onClick'] = ({ key, domEvent }) => {
    domEvent.stopPropagation();
    if (key === 'retitle' || key === 'rename' || key === 'delete') {
      open(key as 'retitle' | 'rename' | 'delete');
    } else if (key === 'duplicate') {
      const t = target as Extract<ActionTarget, { kind: 'trip' }>;
      onAskAI(`把「${t.tripTitle}」(${t.tripPath})复制成一个新方案,用不同的出发日期,并按命名规范 + 在两个文件顶部加 ## 🗺️ Variants 交叉链接。`);
    } else if (key === 'rename-ai') {
      const t = target as Extract<ActionTarget, { kind: 'trip' }>;
      onAskAI(`帮我重命名旅行「${t.tripTitle}」(slug: ${t.slug}):连同配对的预算/打包/签证文件夹一起改名,并更新所有交叉链接。新的日期/目的地是:`);
    }
  };

  async function confirm() {
    setBusy(true);
    try {
      if (mode === 'retitle') {
        const path = target.kind === 'file' ? target.path : target.tripPath;
        await retitlePlan(path, value.trim());
        message.success('标题已更新并提交');
      } else if (mode === 'rename' && target.kind === 'file') {
        const dir = target.path.slice(0, target.path.lastIndexOf('/'));
        const to = `${dir}/${value.trim().replace(/\.md$/, '')}.md`;
        if (to === target.path) {
          setMode(null);
          return;
        }
        await renamePlan([{ from: target.path, to }], value.trim());
        message.success('已重命名并提交');
        onAfterAction({ renamed: { from: target.path, to } });
      } else if (mode === 'delete') {
        if (target.kind === 'file') {
          await deleteEntries({ paths: [target.path], label: target.title });
          onAfterAction({ removed: [target.path] });
        } else {
          await deleteEntries({
            paths: target.deletePaths,
            dirs: target.visaDir ? [target.visaDir] : [],
            label: target.displayName
          });
          onAfterAction({ removed: target.deletePaths });
        }
        message.success('已删除并提交(可从 git 历史恢复)');
      }
      setMode(null);
    } catch (err: any) {
      message.error(err?.message ?? '操作失败');
    } finally {
      setBusy(false);
    }
  }

  const deleteList =
    target.kind === 'file'
      ? [target.path]
      : [...target.deletePaths, ...(target.visaDir ? [target.visaDir + '/ (整个文件夹)'] : [])];

  return (
    <>
      <Dropdown
        menu={{ items, onClick: onMenuClick }}
        trigger={['click']}
        placement="bottomRight"
      >
        <button
          className={`act-btn ${className ?? ''}`}
          aria-label="更多操作"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreOutlined />
        </button>
      </Dropdown>

      <Modal
        open={mode === 'retitle'}
        title="改标题"
        onOk={confirm}
        onCancel={() => setMode(null)}
        confirmLoading={busy}
        okText="保存"
        cancelText="取消"
      >
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="新的标题" autoFocus />
      </Modal>

      <Modal
        open={mode === 'rename'}
        title="重命名文件"
        onOk={confirm}
        onCancel={() => setMode(null)}
        confirmLoading={busy}
        okText="重命名"
        cancelText="取消"
      >
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          addonAfter=".md"
          placeholder="新的文件名(kebab-case)"
          autoFocus
        />
      </Modal>

      <Modal
        open={mode === 'delete'}
        title={target.kind === 'trip' ? '删除整个旅行?' : '删除文件?'}
        onOk={confirm}
        onCancel={() => setMode(null)}
        confirmLoading={busy}
        okButtonProps={{ danger: true }}
        okText="删除"
        cancelText="取消"
      >
        <p style={{ color: 'var(--muted)' }}>将删除以下内容并提交(可从 git 历史恢复):</p>
        <ul className="del-list">
          {deleteList.map((p) => (
            <li key={p}><code>{p}</code></li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
