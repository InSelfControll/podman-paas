import React, { useEffect, useState, useCallback } from 'react';
import { Search, RefreshCw, Play, Layers, Box, X, Download } from 'lucide-react';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Button, Card, Modal, FormField, Spinner, EmptyState } from '../components/ui.jsx';

const SOURCE_META = {
  'portainer-community': { label: 'Portainer Community',  color: '#0d8fba' },
  dokploy:               { label: 'Dokploy',               color: '#a78bfa' },
  custom:                { label: 'Custom',                color: '#f0b429' },
};

function SourceBadge({ source }) {
  const s = SOURCE_META[source] || { label: source, color: 'var(--text3)' };
  return (
    <span style={{
      fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '100px',
      border: `1px solid ${s.color}40`, background: `${s.color}15`, color: s.color,
      fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.05em',
    }}>{s.label}</span>
  );
}

function TemplateCard({ template, onDeploy }) {
  const isStack = template.type === 'stack';
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        {template.logo
          ? <img src={template.logo} alt="" onError={e => e.target.style.display='none'}
              style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'contain', background: 'var(--bg4)', padding: 4, flexShrink: 0 }} />
          : <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--bg4)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {isStack ? <Layers size={16} style={{ color: 'var(--purple)' }} /> : <Box size={16} style={{ color: 'var(--accent)' }} />}
            </div>
        }
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{template.title}</div>
          <SourceBadge source={template.source} />
        </div>
      </div>

      <p style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.5, flexGrow: 1,
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {template.description || 'No description'}
      </p>

      {template.categories?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {template.categories.slice(0, 3).map(c => (
            <span key={c} style={{ fontSize: 10, color: 'var(--text3)', background: 'var(--bg4)', border: '1px solid var(--border)', padding: '1px 6px', borderRadius: 4 }}>{c}</span>
          ))}
        </div>
      )}

      <Button size="sm" onClick={() => onDeploy(template)} style={{ width: '100%', justifyContent: 'center' }}>
        <Play size={12} /> Deploy
      </Button>
    </Card>
  );
}

function DeployModal({ template, open, onClose }) {
  const addToast = useStore(s => s.addToast);
  const isStack = template?.type === 'stack';
  const [name, setName] = useState('');
  const [envOverrides, setEnvOverrides] = useState({});
  const [port, setPort] = useState('');
  const [domain, setDomain] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (!template || !open) return;
    setName(slugify(template.title));
    setEnvOverrides({});
    setError('');
    setDetail(null);
    setDetailLoading(true);
    api.getTemplate(template.id)
      .then(d => {
        setDetail(d);
        const defaults = {};
        for (const e of (d.data?.env || [])) {
          if (e.default && !e.preset) defaults[e.name] = e.default;
        }
        setEnvOverrides(defaults);
      })
      .catch(() => {})
      .finally(() => setDetailLoading(false));
  }, [template, open]);

  const handleDeploy = async () => {
    if (!name) return setError('Name is required');
    setLoading(true); setError('');
    try {
      if (isStack) {
        await api.deployTemplateAsStack(template.id, { name, env: envOverrides });
      } else {
        await api.deployTemplateAsApp(template.id, {
          name, env: envOverrides,
          ...(port && { port: parseInt(port) }),
          ...(domain && { domain }),
        });
      }
      addToast({ message: `${template.title} deployment started`, type: 'success' });
      onClose();
    } catch (e) { 
      // Check for specific error messages and provide helpful guidance
      let errorMsg = e.message;
      if (errorMsg.includes('container app') && errorMsg.includes('compose stack')) {
        errorMsg = 'This is a container app template. Please switch to "Container App" deployment type.';
      } else if (errorMsg.includes('No compose content')) {
        errorMsg = 'This template does not have a compose file available. Try deploying as a Container App instead.';
      }
      setError(errorMsg); 
    }
    setLoading(false);
  };

  const envFields = (detail?.data?.env || []).filter(e => !e.preset);

  return (
    <Modal open={open} onClose={onClose} title={`Deploy: ${template?.title}`} width={560}>
      {error && <div style={{ background: 'var(--red-dim)', border: '1px solid rgba(255,77,109,0.3)', color: 'var(--red)', padding: '10px 14px', borderRadius: 'var(--radius)', marginBottom: 16, fontSize: 13 }}>{error}</div>}

      {/* Deployment type indicator */}
      <div style={{ marginBottom: 16, padding: '8px 12px', background: 'var(--bg3)', borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 600, color: 'var(--text)' }}>Type:</span>
        <span style={{ color: isStack ? 'var(--purple)' : 'var(--accent)', fontWeight: 500 }}>
          {isStack ? '🔧 Compose Stack' : '📦 Container App'}
        </span>
        {template?.type === 'app' && isStack && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--yellow)' }}>
            ⚠️ Will generate compose from container config
          </span>
        )}
      </div>

      <FormField label={isStack ? 'Stack Name' : 'App Name'}>
        <input value={name} onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="my-app" />
      </FormField>

      {!isStack && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <FormField label="Port Override" hint="Leave blank for template default">
            <input type="number" value={port} onChange={e => setPort(e.target.value)} placeholder="auto" />
          </FormField>
          <FormField label="Custom Domain">
            <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="app.example.com" />
          </FormField>
        </div>
      )}

      {detailLoading && <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}><Spinner /></div>}

      {envFields.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <label style={{ marginBottom: 10, display: 'block' }}>Environment Variables</label>
          {envFields.map(e => (
            <div key={e.name} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text2)' }}>{e.name}</span>
                {e.description && <span style={{ fontSize: 11, color: 'var(--text3)' }}>{e.description}</span>}
              </div>
              {e.select ? (
                <select value={envOverrides[e.name] ?? e.default ?? ''} onChange={ev => setEnvOverrides(p => ({ ...p, [e.name]: ev.target.value }))}>
                  {e.select.map(opt => <option key={opt.value} value={opt.value}>{opt.text}</option>)}
                </select>
              ) : (
                <input
                  value={envOverrides[e.name] ?? ''}
                  onChange={ev => setEnvOverrides(p => ({ ...p, [e.name]: ev.target.value }))}
                  placeholder={e.default || `Enter ${e.name}`}
                  type={/password|secret|key/i.test(e.name) ? 'password' : 'text'}
                  style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
                />
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={handleDeploy} loading={loading}><Play size={13} /> Deploy</Button>
      </div>
    </Modal>
  );
}

function SyncModal({ open, onClose, onSynced }) {
  const addToast = useStore(s => s.addToast);
  const [syncing, setSyncing] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const [importing, setImporting] = useState(false);
  const [clearBeforeSync, setClearBeforeSync] = useState(false);

  const syncSource = async (source) => {
    setSyncing(source);
    try {
      const data = await api.syncTemplates(source, clearBeforeSync);
      addToast({ message: data.message || `${data.imported} templates synced from ${source}` });
      onSynced();
    } catch (e) { addToast({ message: e.message, type: 'error' }); }
    setSyncing('');
  };

  const importUrl = async () => {
    if (!customUrl) return;
    setImporting(true);
    try {
      const data = await api.importTemplates(customUrl, customLabel || undefined);
      addToast({ message: `${data.imported} templates imported` });
      setCustomUrl(''); setCustomLabel('');
      onSynced();
    } catch (e) { addToast({ message: e.message, type: 'error' }); }
    setImporting(false);
  };

  const SOURCES = [
    { id: 'portainer-community', icon: '🌐', label: 'Portainer Community',  desc: 'Community templates by Lissy93 (500+)' },
    { id: 'dokploy',             icon: '🚀', label: 'Dokploy Templates',    desc: 'Official Dokploy compose stacks' },
  ];

  return (
    <Modal open={open} onClose={() => { onClose(); setClearBeforeSync(false); }} title="Sync Template Sources" width={580}>
      {/* Clear before sync option */}
      <div style={{ marginBottom: 16, padding: '12px 14px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input 
            type="checkbox" 
            checked={clearBeforeSync} 
            onChange={(e) => setClearBeforeSync(e.target.checked)}
          />
          <span style={{ fontSize: 13, color: 'var(--text)' }}>Clear existing templates before sync</span>
        </label>
        <p style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4, marginLeft: 24 }}>
          This will remove all existing templates from the selected source before importing new ones.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
        {SOURCES.map(s => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{s.icon} {s.label}</div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>{s.desc}</div>
            </div>
            <Button size="sm" loading={syncing === s.id} onClick={() => syncSource(s.id)}>
              <RefreshCw size={12} /> {clearBeforeSync ? 'Clear & Sync' : 'Sync'}
            </Button>
          </div>
        ))}
      </div>

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 20 }}>
        <label style={{ marginBottom: 8 }}>Import Custom URL</label>
        <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>Paste a Portainer JSON URL or raw docker-compose.yml URL.</p>
        <FormField label="URL">
          <input value={customUrl} onChange={e => setCustomUrl(e.target.value)} placeholder="https://raw.githubusercontent.com/.../templates.json" />
        </FormField>
        <FormField label="Label (optional)">
          <input value={customLabel} onChange={e => setCustomLabel(e.target.value)} placeholder="my-templates" />
        </FormField>
        <Button onClick={importUrl} loading={importing} disabled={!customUrl} size="sm">
          <Download size={12} /> Import
        </Button>
      </div>
    </Modal>
  );
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState([]);
  const [total, setTotal] = useState(0);
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterSource, setFilterSource] = useState('');
  const [filterType, setFilterType] = useState('');
  const [deployTarget, setDeployTarget] = useState(null);
  const [showSync, setShowSync] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const params = { limit: 100 };
      if (search) params.q = search;
      if (filterSource) params.source = filterSource;
      if (filterType) params.type = filterType;
      const [data, src] = await Promise.all([
        api.getTemplates(params),
        api.getTemplateSources(),
      ]);
      setTemplates(data.templates || []);
      setTotal(data.total || 0);
      setSources(src || []);
    } catch {}
    setLoading(false);
  }, [search, filterSource, filterType]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const hasFilters = search || filterSource || filterType;

  return (
    <div style={{ padding: '32px', maxWidth: 1200, animation: 'fadeIn 0.2s ease' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Templates</h1>
          <p style={{ color: 'var(--text3)', fontSize: 13 }}>
            {total > 0 ? `${total} templates` : 'No templates'} · Portainer & Dokploy compatible
          </p>
        </div>
        <Button onClick={() => setShowSync(true)}><RefreshCw size={14} /> Sync Sources</Button>
      </div>

      {/* Source filter pills */}
      {sources.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
          {sources.map(s => (
            <button key={s.source} onClick={() => setFilterSource(filterSource === s.source ? '' : s.source)} style={{
              padding: '4px 12px', borderRadius: 100, fontSize: 12, cursor: 'pointer', fontFamily: 'var(--mono)',
              border: `1px solid ${filterSource === s.source ? 'var(--accent)' : 'var(--border)'}`,
              background: filterSource === s.source ? 'var(--accent-dim)' : 'var(--bg3)',
              color: filterSource === s.source ? 'var(--accent)' : 'var(--text3)',
            }}>
              {SOURCE_META[s.source]?.label || s.source} ({s.count})
            </button>
          ))}
        </div>
      )}

      {/* Search + type filter */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)', pointerEvents: 'none' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search templates..." style={{ paddingLeft: 34 }} />
        </div>
        <select value={filterType} onChange={e => setFilterType(e.target.value)} style={{ width: 'auto', minWidth: 150 }}>
          <option value="">All Types</option>
          <option value="app">Container Apps</option>
          <option value="stack">Compose Stacks</option>
        </select>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setFilterSource(''); setFilterType(''); }}>
            <X size={13} /> Clear
          </Button>
        )}
      </div>

      {/* Grid */}
      {loading
        ? <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner /></div>
        : templates.length === 0
          ? (
            <EmptyState
              icon={Layers}
              title={hasFilters ? 'No templates match' : 'No templates yet'}
              description={hasFilters ? 'Try adjusting your search or filters.' : 'Sync Portainer or Dokploy templates to get started with one-click deployments.'}
              action={!hasFilters && <Button onClick={() => setShowSync(true)}><RefreshCw size={14} /> Sync Templates</Button>}
            />
          )
          : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
              {templates.map(t => <TemplateCard key={t.id} template={t} onDeploy={setDeployTarget} />)}
            </div>
          )
      }

      {deployTarget && (
        <DeployModal template={deployTarget} open={!!deployTarget} onClose={() => setDeployTarget(null)} />
      )}
      <SyncModal open={showSync} onClose={() => setShowSync(false)} onSynced={fetchAll} />
    </div>
  );
}

function slugify(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 40) || 'app';
}
