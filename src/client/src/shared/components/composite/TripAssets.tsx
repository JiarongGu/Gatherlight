import { Card, Button, Space, Typography } from '@/shared/components/visual';
import { FilePdfOutlined, FileTextOutlined, DownloadOutlined } from '@ant-design/icons';
import type { PlanFile, TripAsset } from '@/lib/collectFiles';

const { Text, Title } = Typography;

interface Props {
  active: PlanFile | null;
  assets: TripAsset[];
  onSelect: (path: string) => void;
}

function tripSlug(active: PlanFile | null): string | null {
  if (!active) return null;
  if (active.path.startsWith('plans/trips/')) return active.name;
  if (active.path.startsWith('plans/visa/')) {
    const parts = active.path.split('/');
    return parts[2] ?? null;
  }
  return null;
}

function formatSize(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Shows trip-paired non-markdown assets (currently visa PDFs + data JSON).
 * Dark-theme styled via the viewer's --panel / --panel-2 / --text / --border vars.
 */
export function TripAssets({ active, assets, onSelect }: Props) {
  const slug = tripSlug(active);
  if (!slug) return null;
  const tripAssets = assets.filter((a) => a.slug === slug);
  if (tripAssets.length === 0) return null;

  const visaPdfs = tripAssets.filter((a) => a.category === 'visa' && a.kind === 'pdf');
  const visaData = tripAssets.filter((a) => a.category === 'visa' && a.kind === 'json');
  const visaReadmePath = `plans/visa/${slug}/README.md`;
  const onReadmePage = active?.path === visaReadmePath;

  const fileRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: 4
  };

  const filenameStyle: React.CSSProperties = {
    flex: 1,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    color: 'var(--text)'
  };

  return (
    <Card
      size="small"
      className="no-print"
      styles={{
        body: { background: 'var(--panel)', padding: 12 },
        header: { background: 'var(--panel)', borderBottom: '1px solid var(--border)', color: 'var(--text)' }
      }}
      style={{
        marginTop: 16,
        marginBottom: 16,
        background: 'var(--panel)',
        borderColor: 'var(--border)'
      }}
      title={
        <Space>
          <FilePdfOutlined style={{ color: 'var(--accent)' }} />
          <span style={{ color: 'var(--text)' }}>🛂 Visa Documents</span>
        </Space>
      }
      extra={
        !onReadmePage && (
          <Button
            type="link"
            size="small"
            onClick={() => onSelect(visaReadmePath)}
            style={{ color: 'var(--accent)' }}
          >
            Open README →
          </Button>
        )
      }
    >
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        {visaPdfs.length > 0 && (
          <div>
            <Title level={5} style={{ margin: '0 0 8px', color: 'var(--text)', fontSize: 13 }}>
              <FilePdfOutlined /> PDF documents
            </Title>
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {visaPdfs.map((a) => {
                const isFilled = a.filename.includes('filled');
                return (
                  <div
                    key={a.path}
                    style={{
                      ...fileRowStyle,
                      ...(isFilled
                        ? {
                            background: 'var(--accent-bg)',
                            borderColor: 'var(--accent)'
                          }
                        : {})
                    }}
                  >
                    <FilePdfOutlined
                      style={{ color: isFilled ? 'var(--highlight)' : 'var(--muted)' }}
                    />
                    <span style={filenameStyle}>
                      {a.filename}
                      {isFilled && (
                        <span
                          style={{
                            marginLeft: 8,
                            color: 'var(--highlight)',
                            fontFamily: 'inherit',
                            fontWeight: 600,
                            fontSize: 12
                          }}
                        >
                          ★ submit-ready
                        </span>
                      )}
                    </span>
                    <Space>
                      <Button
                        size="small"
                        icon={<DownloadOutlined />}
                        href={a.url}
                        download={a.filename}
                        type={isFilled ? 'primary' : 'default'}
                      >
                        Download
                      </Button>
                      <Button
                        size="small"
                        href={a.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Preview
                      </Button>
                    </Space>
                  </div>
                );
              })}
            </Space>
          </div>
        )}

        {visaData.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <Title level={5} style={{ margin: '4px 0 8px', color: 'var(--text)', fontSize: 13 }}>
              <FileTextOutlined /> Data files
              <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 11, marginLeft: 8 }}>
                source of truth — edit + regenerate PDF
              </span>
            </Title>
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {visaData.map((a) => (
                <div key={a.path} style={fileRowStyle}>
                  <FileTextOutlined style={{ color: 'var(--muted)' }} />
                  <span style={filenameStyle}>
                    {a.filename}
                    <span style={{ marginLeft: 8, color: 'var(--muted)', fontFamily: 'inherit', fontSize: 11 }}>
                      {formatSize(a.sizeBytes)}
                    </span>
                  </span>
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    href={a.url}
                    download={a.filename}
                  >
                    Download
                  </Button>
                </div>
              ))}
            </Space>
          </div>
        )}

        <Text style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
          📁 Files at <code style={{ background: 'var(--panel-2)', padding: '1px 5px', borderRadius: 3 }}>plans/visa/{slug}/</code> · regenerate filled PDF via <code style={{ background: 'var(--panel-2)', padding: '1px 5px', borderRadius: 3 }}>/fill-itinerary</code> after editing JSON.
        </Text>
      </Space>
    </Card>
  );
}
