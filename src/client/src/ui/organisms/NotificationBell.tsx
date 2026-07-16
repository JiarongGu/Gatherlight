import { useEffect, useState, useCallback } from 'react';
import { Badge, Popover } from 'antd';
import { BellOutlined } from '@ant-design/icons';

interface AppNotification {
  id: string;
  createdAt: string;
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  read: boolean;
}

// App-wide notification feed: a bell in the planner top bar. Loads the backlog, then opens the
// server SSE stream for new ones — prepending them and firing a browser Notification (when the user
// granted permission) so a background-job result / reminder surfaces even off-screen. Self-contained
// (no props) so TopBar just drops it in.
export function NotificationBell() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    try {
      const d = await (await fetch('/api/notifications?limit=30')).json();
      setItems(d.items ?? []);
      setUnread(d.unreadCount ?? 0);
    } catch {
      /* keep last */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Ask once for browser-notification permission (best-effort; ignored if denied).
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  // Live stream: new notifications prepend + fire a browser toast.
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/notifications/stream');
      es.onmessage = (e) => {
        try {
          const n = JSON.parse(e.data) as AppNotification;
          if (!n?.id) return;
          setItems((prev) => [n, ...prev.filter((x) => x.id !== n.id)].slice(0, 50));
          setUnread((u) => u + 1);
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification(n.title, { body: n.body ?? undefined });
          }
        } catch {
          /* keep-alive / non-JSON frame */
        }
      };
    } catch {
      /* SSE unavailable */
    }
    return () => es?.close();
  }, []);

  const markAllRead = async () => {
    setUnread(0);
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    await fetch('/api/notifications/read-all', { method: 'POST' }).catch(() => {});
  };

  const content = (
    <div className="ntf-pop">
      <div className="ntf-pop-head">
        <span>通知 · Notifications</span>
        {unread > 0 && <button className="ntf-readall" onClick={markAllRead}>全部已读</button>}
      </div>
      {items.length === 0 ? (
        <div className="ntf-empty">暂无通知</div>
      ) : (
        <div className="ntf-list">
          {items.map((n) => (
            <div className={`ntf-item${n.read ? '' : ' unread'} k-${n.kind}`} key={n.id}>
              <div className="ntf-item-title">{n.title}</div>
              {n.body && <div className="ntf-item-body">{n.body}</div>}
              <div className="ntf-item-time">{n.createdAt.slice(0, 16).replace('T', ' ')}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <Popover
      content={content}
      trigger="click"
      placement="bottomRight"
      onOpenChange={(o) => { if (o) load(); }}
    >
      <button className="topbar-icon-btn" aria-label="通知">
        <Badge count={unread} size="small" offset={[-1, 1]}>
          <BellOutlined />
        </Badge>
      </button>
    </Popover>
  );
}
