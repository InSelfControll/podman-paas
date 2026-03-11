import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Play, Square, RotateCcw, Trash2, Plus, X, ExternalLink, ChevronLeft, Eye, EyeOff, RefreshCw, Edit3, Webhook, Copy, Check } from 'lucide-react';
import { api, createLogStream } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Button, StatusBadge, Card, Modal, FormField, LogViewer, Tabs, Spinner } from '../components/ui.jsx';

export default function AppDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const addToast = useStore(s => s.addToast);
  const fetchApps = useStore(s => s.fetchApps);

  const [app, setApp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('overview');
  const [actionLoading, setActionLoading] = useState('');
  const [logLines, setLogLines] = useState([]);
  const [deployLogLines, setDeployLogLines] = useState([]);
  const [envVars, setEnvVars] = useState([]);
  const [envDirty, setEnvDirty] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [activeDeployId, setActiveDeployId] = useState(null);
  const [webhookSecret, setWebhookSecret] = useState(null);
  const [copied, setCopied] = useState(false);
  const [logsCopied, setLogsCopied] = useState(false);
  const wsRef = useRef(null);

  const fetchApp = async () => {
    try {
      const data = await api.getApp(id);
      setApp(data);
      setEnvVars(data.env_vars || []);
    } catch { navigate('/apps'); }
    setLoading(false);
  };

  useEffect(() => {
    fetchApp();
  }, [id]);

  // Auto-refresh logs when on logs tab
  useEffect(() => {
    if (tab !== 'logs' || !app?.container_id) return;
    fetchLogs();

    const ws = createLogStream(`/app/${id}/stream`, (line) => {
      setLogLines(prev => [...prev.slice(-500), line]);
    });
    wsRef.current = ws;
    return () => ws?.close();
  }, [tab, app?.container_id]);

  const fetchLogs = async () => {
    try {
      const data = await api.getAppLogs(id);
      const lines = (data.logs || '').split('\n').filter(Boolean);
      setLogLines(lines);
    } catch {}
  };

  const action = async (name, fn) => {
    setActionLoading(name);
    try {
      await fn();
      await fetchApp();
      fetchApps();
      addToast({ message: `${name} successful`, type: 'success' });
    } catch (e) {
      addToast({ message: e.message, type: 'error' });
    }
    setActionLoading('');
  };

  const handleDeploy = async () => {
    setActionLoading('deploy');
    setDeployLogLines([]);
    setTab('deployments');
    try {
      const { deploymentId } = await api.deployApp(id);
      setActiveDeployId(deploymentId);

      const ws = createLogStream(
        `/deployment/${deploymentId}/stream`,
        (line) => setDeployLogLines(prev => [...prev, line]),
        async () => {
          await fetchApp();
          fetchApps();
          setActiveDeployId(null);
          setActionLoading('');
        }
      );
      wsRef.current = ws;
    } catch (e) {
      addToast({ message: e.message, type: 'error' });
      setActionLoading('');
    }
  };

  const handleDelete = async () => {
    await action('Delete', () => api.deleteApp(id));
    navigate('/apps');
  };

  const saveEnvVars = async () => {
    try {
      await api.setEnvVars(id, envVars);
      setEnvDirty(false);
      addToast({ message: 'Environment variables saved', type: 'success' });
    } catch (e) {
      addToast({ message: e.message, type: 'error' });
    }
  };

  const addEnvVar = () => {
    setEnvVars(prev => [...prev, { key: '', value: '', is_secret: 0 }]);
    setEnvDirty(true);
  };

  const updateEnvVar = (i, field, val) => {
    setEnvVars(prev => prev.map((e, idx) => idx === i ? { ...e, [field]: val } : e));
    setEnvDirty(true);
  };

  const removeEnvVar = (i) => {
    setEnvVars(prev => prev.filter((_, idx) => idx !== i));
    setEnvDirty(true);
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: '80px' }}><Spinner /></div>;
  if (!app) return null;

  const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'logs', label: 'Logs' },
    { id: 'env', label: 'Env Vars' },
    { id: 'deployments', label: 'Deployments' },
  ];

  return (
    <div style={{ padding: '32px', maxWidth: 1000, animation: 'fadeIn 0.2s ease' }}>
      {/* Header */}
      <div style={{ marginBottom: '28px' }}>
        <button onClick={() => navigate('/apps')} style={{
          background: 'none', border: 'none', color: 'var(--text3)', fontSize: '13px',
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '12px'
        }}>
          <ChevronLeft size={14} /> Apps
        </button>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div style={{
              width: 42, height: 42, borderRadius: '10px',
              background: 'var(--bg3)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '18px', fontFamily: 'var(--mono)', color: 'var(--accent)', fontWeight: 700
            }}>{app.name[0].toUpperCase()}</div>
            <div>
              <h1 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text)' }}>{app.name}</h1>
              {app.description && <p style={{ color: 'var(--text3)', fontSize: '13px' }}>{app.description}</p>}
            </div>
            <StatusBadge status={app.status} />
          </div>

          <div style={{ display: 'flex', gap: '8px' }}>
            {app.host_port && (
              <a href={`http://localhost:${app.host_port}`} target="_blank" rel="noreferrer">
                <Button variant="ghost" size="sm"><ExternalLink size={13} /> Open</Button>
              </a>
            )}
            <Button variant="secondary" size="sm" onClick={() => setShowEdit(true)}>
              <Edit3 size={13} /> Edit
            </Button>
            <Button onClick={handleDeploy} loading={actionLoading === 'deploy'} size="sm">
              <Play size={13} /> Deploy
            </Button>
            {app.status === 'running' && (
              <Button variant="secondary" size="sm" loading={actionLoading === 'Stop'} onClick={() => action('Stop', () => api.stopApp(id))}>
                <Square size={13} /> Stop
              </Button>
            )}
            <Button variant="secondary" size="sm" loading={actionLoading === 'Restart'} onClick={() => action('Restart', () => api.restartApp(id))}>
              <RotateCcw size={13} /> Restart
            </Button>
            <Button variant="danger" size="sm" onClick={() => setShowDelete(true)}>
              <Trash2 size={13} />
            </Button>
          </div>
        </div>
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {/* Overview */}
      {tab === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <Card>
              <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)', marginBottom: '16px' }}>Configuration</h3>
              {[
                ['Status', <StatusBadge status={app.status} />],
                ['Container Port', app.port],
                ['Host Port', app.host_port || '—'],
                ['Domain', app.domain || '—'],
                ['Build Method', app.build_method],
                ['Branch', app.branch],
                ['Memory Limit', app.memory_limit ? formatBytes(app.memory_limit) : 'Default'],
                ['CPU Limit', app.cpu_limit ? `${app.cpu_limit} CPU` : 'Default'],
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
                  <span style={{ color: 'var(--text3)' }}>{k}</span>
                  <span style={{ color: 'var(--text)', fontFamily: typeof v === 'string' ? 'var(--mono)' : 'inherit', fontSize: '12px' }}>{v}</span>
                </div>
              ))}
            </Card>

            <Card>
              <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)', marginBottom: '16px' }}>Source</h3>
              {[
                ['Image', app.image],
                ['Git URL', app.git_url],
                ['Container ID', app.container_id ? app.container_id.substring(0, 12) : null],
                ['Created', new Date(app.created_at).toLocaleDateString()],
                ['Updated', new Date(app.updated_at).toLocaleDateString()],
              ].filter(([, v]) => v).map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
                  <span style={{ color: 'var(--text3)' }}>{k}</span>
                  <span style={{ color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: '12px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
                </div>
              ))}
            </Card>
          </div>

          {/* Webhook Section */}
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Webhook size={14} /> Webhooks
              </h3>
              <Button size="sm" variant="secondary" onClick={async () => {
                try {
                  const res = await api.generateWebhookSecret(id);
                  setWebhookSecret(res.secret);
                  await fetchApp();
                  addToast({ message: 'Webhook secret generated', type: 'success' });
                } catch (e) { addToast({ message: e.message, type: 'error' }); }
              }}>
                {app.webhook_secret ? 'Regenerate' : 'Generate'} Secret
              </Button>
            </div>
            {(app.webhook_secret || webhookSecret) ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div>
                  <label style={{ fontSize: '12px', color: 'var(--text3)', marginBottom: '4px', display: 'block' }}>Webhook URL</label>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <input readOnly value={`${window.location.origin}/api/webhooks/github/${id}`} style={{ fontFamily: 'var(--mono)', fontSize: '12px', flex: 1 }} />
                    <button onClick={() => {
                      navigator.clipboard.writeText(`${window.location.origin}/api/webhooks/github/${id}`);
                      setCopied(true); setTimeout(() => setCopied(false), 2000);
                    }} style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: '6px' }}>
                      {copied ? <Check size={14} style={{ color: 'var(--accent)' }} /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>
                {webhookSecret && (
                  <div>
                    <label style={{ fontSize: '12px', color: 'var(--text3)', marginBottom: '4px', display: 'block' }}>Secret (copy now — won't be shown again)</label>
                    <input readOnly value={webhookSecret} style={{ fontFamily: 'var(--mono)', fontSize: '12px' }} />
                  </div>
                )}
                <p style={{ fontSize: '12px', color: 'var(--text3)' }}>
                  Configure this URL in your GitHub repository Settings → Webhooks. Set content type to <code>application/json</code> and select "Just the push event".
                </p>
              </div>
            ) : (
              <p style={{ fontSize: '13px', color: 'var(--text3)' }}>Generate a webhook secret to enable automatic deploys on git push.</p>
            )}
          </Card>
        </div>
      )}

      {/* Logs */}
      {tab === 'logs' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <Button 
              variant="secondary" 
              size="sm" 
              onClick={() => {
                navigator.clipboard.writeText(logLines.join('\n'));
                setLogsCopied(true);
                setTimeout(() => setLogsCopied(false), 2000);
              }}
            >
              {logsCopied ? <Check size={13} style={{ color: 'var(--accent)' }} /> : <Copy size={13} />} 
              {logsCopied ? 'Copied!' : 'Copy All'}
            </Button>
            <Button variant="ghost" size="sm" onClick={fetchLogs}><RefreshCw size={13} /> Refresh</Button>
          </div>
          <LogViewer lines={logLines} height={500} />
        </div>
      )}

      {/* Env Vars */}
      {tab === 'env' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '16px' }}>
            <Button variant="ghost" size="sm" onClick={() => setShowSecrets(s => !s)}>
              {showSecrets ? <EyeOff size={13} /> : <Eye size={13} />} {showSecrets ? 'Hide' : 'Show'} Secrets
            </Button>
            <div style={{ display: 'flex', gap: '8px' }}>
              <Button variant="secondary" size="sm" onClick={addEnvVar}><Plus size={13} /> Add</Button>
              {envDirty && <Button size="sm" onClick={saveEnvVars}>Save Changes</Button>}
            </div>
          </div>

          {envVars.length === 0
            ? <p style={{ color: 'var(--text3)', fontSize: '13px', textAlign: 'center', padding: '40px' }}>No environment variables yet.</p>
            : envVars.map((ev, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 40px', gap: '8px', marginBottom: '8px', alignItems: 'center' }}>
                <input value={ev.key} onChange={e => updateEnvVar(i, 'key', e.target.value)} placeholder="KEY" style={{ fontFamily: 'var(--mono)', fontSize: '12px' }} />
                <input
                  type={ev.is_secret && !showSecrets ? 'password' : 'text'}
                  value={ev.value} onChange={e => updateEnvVar(i, 'value', e.target.value)}
                  placeholder="value" style={{ fontFamily: 'var(--mono)', fontSize: '12px' }}
                />
                <button onClick={() => removeEnvVar(i)} style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: '6px' }}>
                  <X size={14} />
                </button>
              </div>
            ))
          }
        </div>
      )}

      {/* Deployments */}
      {tab === 'deployments' && (
        <div>
          {activeDeployId && (
            <Card style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Spinner size={14} />
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--accent)' }}>Deploying...</span>
                </div>
                {deployLogLines.length > 0 && (
                  <button 
                    onClick={() => {
                      navigator.clipboard.writeText(deployLogLines.join('\n'));
                      addToast({ message: 'Deployment logs copied', type: 'success' });
                    }}
                    style={{ 
                      background: 'none', 
                      border: 'none', 
                      color: 'var(--text3)', 
                      cursor: 'pointer',
                      fontSize: '12px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px'
                    }}
                  >
                    <Copy size={12} /> Copy
                  </button>
                )}
              </div>
              <LogViewer lines={deployLogLines} height={300} />
            </Card>
          )}

          {(app.deployments || []).map(d => (
            <Card key={d.id} style={{ marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
                    <StatusBadge status={d.status} />
                    <span style={{ fontFamily: 'var(--mono)', fontSize: '12px', color: 'var(--text3)' }}>#{d.id.substring(0, 8)}</span>
                    {d.commit_sha && <span style={{ fontFamily: 'var(--mono)', fontSize: '12px', color: 'var(--text2)' }}>{d.commit_sha}</span>}
                  </div>
                  {d.commit_message && <p style={{ fontSize: '12px', color: 'var(--text3)' }}>{d.commit_message}</p>}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text3)', textAlign: 'right' }}>
                  <div>{new Date(d.started_at).toLocaleString()}</div>
                  {d.finished_at && <div>{Math.round((new Date(d.finished_at) - new Date(d.started_at)) / 1000)}s</div>}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Edit Modal */}
      <EditAppModal open={showEdit} app={app} onClose={() => setShowEdit(false)} onSaved={() => { fetchApp(); fetchApps(); }} />

      {/* Delete Modal */}
      <Modal open={showDelete} onClose={() => setShowDelete(false)} title="Delete App" width={400}>
        <p style={{ color: 'var(--text2)', marginBottom: '24px', lineHeight: 1.6 }}>
          Are you sure you want to delete <strong style={{ color: 'var(--text)' }}>{app.name}</strong>? This will stop the container and remove all configuration. This action cannot be undone.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <Button variant="secondary" onClick={() => setShowDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete}>Delete App</Button>
        </div>
      </Modal>
    </div>
  );
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return 'Unlimited';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${Math.round(val)} ${units[i]}`;
}

function EditAppModal({ open, app, onClose, onSaved }) {
  const addToast = useStore(s => s.addToast);
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (app && open) {
      setForm({
        description: app.description || '',
        git_url: app.git_url || '',
        branch: app.branch || 'main',
        dockerfile_path: app.dockerfile_path || 'Dockerfile',
        build_method: app.build_method || 'dockerfile',
        port: String(app.port || 3000),
        domain: app.domain || '',
        image: app.image || '',
        memory_limit: String(app.memory_limit || 0),
        cpu_limit: String(app.cpu_limit || 0),
      });
      setError('');
    }
  }, [app, open]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    setLoading(true);
    setError('');
    try {
      await api.updateApp(app.id, {
        description: form.description || null,
        git_url: form.git_url || null,
        branch: form.branch,
        dockerfile_path: form.dockerfile_path,
        build_method: form.build_method,
        port: parseInt(form.port) || 3000,
        domain: form.domain || null,
        image: form.image || null,
        memory_limit: parseInt(form.memory_limit) || 0,
        cpu_limit: parseFloat(form.cpu_limit) || 0,
      });
      addToast({ message: 'App updated', type: 'success' });
      onSaved();
      onClose();
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  return (
    <Modal open={open} onClose={onClose} title={`Edit: ${app?.name}`} width={560}>
      {error && <div style={{ background: 'var(--red-dim)', border: '1px solid rgba(255,77,109,0.3)', color: 'var(--red)', padding: '10px 14px', borderRadius: 'var(--radius)', marginBottom: '16px', fontSize: '13px' }}>{error}</div>}
      <FormField label="Description">
        <input value={form.description || ''} onChange={e => set('description', e.target.value)} />
      </FormField>
      <FormField label="Git URL">
        <input value={form.git_url || ''} onChange={e => set('git_url', e.target.value)} />
      </FormField>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <FormField label="Branch">
          <input value={form.branch || ''} onChange={e => set('branch', e.target.value)} />
        </FormField>
        <FormField label="Build Method">
          <select value={form.build_method || 'dockerfile'} onChange={e => set('build_method', e.target.value)}>
            <option value="dockerfile">Dockerfile</option>
            <option value="nixpacks">Nixpacks</option>
          </select>
        </FormField>
      </div>
      <FormField label="Dockerfile Path">
        <input value={form.dockerfile_path || ''} onChange={e => set('dockerfile_path', e.target.value)} />
      </FormField>
      <FormField label="Container Image">
        <input value={form.image || ''} onChange={e => set('image', e.target.value)} placeholder="nginx:latest" />
      </FormField>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <FormField label="Container Port">
          <input type="number" value={form.port || ''} onChange={e => set('port', e.target.value)} />
        </FormField>
        <FormField label="Custom Domain">
          <input value={form.domain || ''} onChange={e => set('domain', e.target.value)} />
        </FormField>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <FormField label="Memory Limit">
          <select value={form.memory_limit || '0'} onChange={e => set('memory_limit', e.target.value)}>
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
          <select value={form.cpu_limit || '0'} onChange={e => set('cpu_limit', e.target.value)}>
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
        <Button onClick={handleSave} loading={loading}>Save Changes</Button>
      </div>
    </Modal>
  );
}
