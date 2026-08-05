import { useEffect, useState } from 'react';
import { Alert, Spin } from '@/ui/atoms';
import { UiTree } from '@/ui/blocks/UiTree';
import type { UiNode } from '@/ui/blocks/registry';
import { get } from '@/lib/apiClient';   // apiClient exports get/post — verified, there is no apiGet

interface PageView {
  name: string; title: string; status: 'ready' | 'invalid'; root?: UiNode; reason?: string;
}

export function SitePage({ name, onOpenRecord }: { name: string; onOpenRecord?: (p: string) => void }) {
  const [page, setPage] = useState<PageView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setPage(null); setError(null);
    get<PageView>(`/api/ui/pages/${encodeURIComponent(name)}`)
      .then((p) => { if (live) setPage(p); })
      .catch((e) => { if (live) setError(String(e?.message ?? e)); });
    return () => { live = false; };
  }, [name]);

  if (error) return <Alert type="error" message="打不开这个页面 · Could not open this page" description={error} />;
  if (!page) return <Spin />;
  if (page.status !== 'ready' || !page.root) {
    return (
      <Alert
        type="warning"
        message="这个页面暂时无法显示 · This page cannot be displayed"
        description={page.reason ?? ''}
      />
    );
  }
  return (
    <article className="site-page">
      <h1>{page.title}</h1>
      <UiTree node={page.root} onOpenRecord={onOpenRecord} />
    </article>
  );
}
