import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Boxes, RefreshCw } from 'lucide-react';
import { useStore } from '../lib/store.js';
import { Button, StatusBadge, Card, EmptyState, Modal, FormField, Spinner } from '../components/ui.jsx';
import { api } from '../lib/api.js';

function CreateAppModal({ open, onClose, onCreated }) {
  const addToast = useStore(s => s.addToast);
  const [form, setForm] = useState({
    name: '', description: '', git_url: '', branch: 'main',
    build_method: 'dockerfile', dockerfile_path: 'Dockerfile',
    port: '3000', image: '', domain: '',
    memory_limit: '536870912', cpu_limit: '1.0',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sourceType, setSourceType] = useState('git');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async () => {
    if (!form.name) return setError('App name is required');
    setLoading(true);
    setError('');
    try {
      const body = {
        ...form, port: parseInt(form.port) || 3000,
        git_url: sourceType === 'git' ? form.git_url : null,
        image: sourceType === 'image' ? form.image : null,
        memory_limit: parseInt(form.memory_limit) || 0,
        cpu_limit: parseFloat(form.cpu_limit) || 0,
      };
      const created = await api.createApp(body);
      addToast({ message: `App "${created.name}" created`, type: 'success' });
      onCreated(created);
      onClose();
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  return (
    <Modal open={open} onClose={onClose} title="Create New App" width={560}>
      {error && <div style={{ background: 'var(--red-dim)', border: '1px solid rgba(255,77,109,0.3)', color: 'var(--red)', padding: '10px 14px', borderRadius: 'var(--radius)', marginBottom: '16px', fontSize: '13px' }}>{error}</div>}

      <FormField label="App Name *">
        <input value={form.name} onChange={e => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="my-app" />
      </FormField>

      <FormField label="Description">
        <input value={form.description} onChange={e => set('description', e.target.value)} placeholder="Optional description" />
      </FormField>

      <FormField label="Source Type">
        <div style={{ display: 'flex', gap: '8px' }}>
          {['git', 'image'].map(t => (
            <button key={t} onClick={() => setSourceType(t)} style={{
              flex: 1, padding: '8px', borderRadius: 'var(--radius)',
              border: `1px solid ${sourceType === t ? 'var(--accent)' : 'var(--border)'}`,
              background: sourceType === t ? 'var(--accent-dim)' : 'var(--bg3)',
              color: sourceType === t ? 'var(--accent)' : 'var(--text3)',
              fontSize: '13px', cursor: 'pointer', textTransform: 'capitalize'
            }}>{t === 'git' ? '📦 Git Repository' : '🐳 Container Image'}</button>
          ))}
        </div>
      </FormField>

      {sourceType === 'git' ? (
        <>
          <FormField label="Git URL">
            <input value={form.git_url} onChange={e => set('git_url', e.target.value)} placeholder="https://github.com/user/repo" />
          </FormField>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormField label="Branch">
              <input value={form.branch} onChange={e => set('branch', e.target.value)} placeholder="main" />
            </FormField>
            <FormField label="Build Method">
              <select value={form.build_method} onChange={e => set('build_method', e.target.value)}>
                <option value="dockerfile">Dockerfile</option>
                <option value="nixpacks">Nixpacks (auto)</option>
              </select>
            </FormField>
          </div>
          {form.build_method === 'dockerfile' && (
            <FormField label="Dockerfile Path">
              <input value={form.dockerfile_path} onChange={e => set('dockerfile_path', e.target.value)} placeholder="Dockerfile" />
            </FormField>
          )}
        </>
      ) : (
        <FormField label="Container Image">
          <input value={form.image} onChange={e => set('image', e.target.value)} placeholder="nginx:latest" />
        </FormField>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <FormField label="Container Port">
          <input type="number" value={form.port} onChange={e => set('port', e.target.value)} placeholder="3000" />
        </FormField>
        <FormField label="Custom Domain">
          <input value={form.domain} onChange={e => set('domain', e.target.value)} placeholder="app.example.com" />
        </FormField>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <FormField label="Memory Limit">
          <select value={form.memory_limit} onChange={e => set('memory_limit', e.target.value)}>
            <option value="134217728">128 MB</option>
            <option value="268435456">256 MB</option>
            <option value="536870912">512 MB</option>
            <option value="1073741824">1 GB</option>
            <option value="2147483648">2 GB</option>
            <option value="4294967296">4 GB</option>
            <option value="0">Unlimited</option>
          </select>
        </FormField>
        <FormField label="CPU Limit">
          <select value={form.cpu_limit} onChange={e => set('cpu_limit', e.target.value)}>
            <option value="0.25">0.25 CPU</option>
            <option value="0.5">0.5 CPU</option>
            <option value="1.0">1.0 CPU</option>
            <option value="2.0">2.0 CPU</option>
            <option value="0">Unlimited</option>
          </select>
        </FormField>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSubmit} loading={loading}>Create App</Button>
      </div>
    </Modal>
  );
}

export default function AppsPage() {
  const navigate = useNavigate();
  const { apps, appsLoading, fetchApps, addToast } = useStore();
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => { fetchApps(); }, []);

  const filtered = apps.filter(a =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    (a.description || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ padding: '32px', maxWidth: 1100, animation: 'fadeIn 0.2s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '28px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text)', marginBottom: '4px' }}>Apps</h1>
          <p style={{ color: 'var(--text3)', fontSize: '13px' }}>{apps.length} application{apps.length !== 1 ? 's' : ''}</p>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button onClick={fetchApps} style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: '6px' }}>
            <RefreshCw size={16} style={{ animation: appsLoading ? 'spin 1s linear infinite' : 'none' }} />
          </button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus size={14} /> New App
          </Button>
        </div>
      </div>

      {apps.length > 0 && (
        <div style={{ position: 'relative', marginBottom: '20px', maxWidth: 320 }}>
          <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search apps..." style={{ paddingLeft: 34 }} />
        </div>
      )}

      {appsLoading && apps.length === 0
        ? <div style={{ display: 'flex', justifyContent: 'center', padding: '60px' }}><Spinner /></div>
        : filtered.length === 0
          ? <EmptyState icon={Boxes} title={search ? 'No matches' : 'No apps yet'} description={search ? 'Try a different search.' : 'Create your first app to get started.'} action={!search && <Button onClick={() => setShowCreate(true)}><Plus size={14} /> Create App</Button>} />
          : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
              {filtered.map(app => (
                <Card key={app.id} onClick={() => navigate(`/apps/${app.id}`)}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div style={{
                        width: 36, height: 36, borderRadius: '9px',
                        background: 'var(--bg4)', border: '1px solid var(--border)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '15px', fontFamily: 'var(--mono)', color: 'var(--accent)', fontWeight: 700
                      }}>
                        {app.name[0].toUpperCase()}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text)' }}>{app.name}</div>
                        {app.description && <div style={{ fontSize: '12px', color: 'var(--text3)', marginTop: '1px' }}>{app.description}</div>}
                      </div>
                    </div>
                    <StatusBadge status={app.live_status || app.status} />
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    {app.domain && (
                      <div style={{ fontSize: '12px', color: 'var(--text3)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        🌐 {app.domain}
                      </div>
                    )}
                    {app.host_port && (
                      <div style={{ fontSize: '12px', color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                        🔌 :{app.host_port}
                      </div>
                    )}
                    {app.git_url && (
                      <div style={{ fontSize: '12px', color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        📦 {app.git_url.replace('https://', '')}
                      </div>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )
      }

      <CreateAppModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={fetchApps} />
    </div>
  );
}
