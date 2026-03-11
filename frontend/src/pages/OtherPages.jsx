import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Layers, Play, Square, Trash2, RefreshCw, Container, Activity, Settings as SettingsIcon, Download, Upload, Users, Key, FileText, Terminal as TerminalIcon } from 'lucide-react';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Button, StatusBadge, Card, EmptyState, Modal, FormField, Spinner, Badge, LogViewer, Terminal } from '../components/ui.jsx';

// ── Stacks Page ──────────────────────────────────────────────────────────────
export function StacksPage() {
  const { stacks, fetchStacks, addToast } = useStore();
  const [showCreate, setShowCreate] = useState(false);
  const [editStack, setEditStack] = useState(null);
  const [loading, setLoading] = useState(false);
  const [actionId, setActionId] = useState('');
  const [viewStack, setViewStack] = useState(null);
  const [stackLogs, setStackLogs] = useState('');

  useEffect(() => { fetchStacks(); }, []);
  
  // Refresh stacks periodically
  useEffect(() => {
    const interval = setInterval(fetchStacks, 10000);
    return () => clearInterval(interval);
  }, [fetchStacks]);

  const action = async (id, name, fn) => {
    setActionId(`${id}-${name}`);
    try { 
      await fn(); 
      await fetchStacks(); 
      addToast({ message: `${name} successful` }); 
    }
    catch (e) { addToast({ message: e.message, type: 'error' }); }
    setActionId('');
  };
  
  const viewStackLogs = async (stack) => {
    try {
      const data = await api.getStackLogs(stack.id, 100);
      setStackLogs(data.logs || 'No logs available');
      setViewStack(stack);
    } catch (e) {
      addToast({ message: e.message, type: 'error' });
    }
  };

  return (
    <div style={{ padding: '32px', maxWidth: 1000, animation: 'fadeIn 0.2s ease' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '28px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text)', marginBottom: '4px' }}>Stacks</h1>
          <p style={{ color: 'var(--text3)', fontSize: '13px' }}>Podman Compose stacks</p>
        </div>
        <Button onClick={() => setShowCreate(true)}><Plus size={14} /> New Stack</Button>
      </div>

      {stacks.length === 0
        ? <EmptyState icon={Layers} title="No stacks" description="Create a compose stack to run multi-container applications." action={<Button onClick={() => setShowCreate(true)}><Plus size={14} /> Create Stack</Button>} />
        : stacks.map(s => (
          <Card key={s.id} style={{ marginBottom: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: 36, height: 36, background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.3)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Layers size={16} style={{ color: 'var(--purple)' }} />
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text)' }}>{s.name}</div>
                  {s.description && <div style={{ fontSize: '12px', color: 'var(--text3)' }}>{s.description}</div>}
                  {s.container_count > 0 && (
                    <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>
                      {s.running_count || 0}/{s.container_count} containers running
                    </div>
                  )}
                </div>
                <StatusBadge status={s.status} />
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <Button size="sm" variant="ghost" onClick={() => viewStackLogs(s)}>Logs</Button>
                <Button size="sm" variant="secondary" onClick={() => setEditStack(s)}>Edit</Button>
                {s.status !== 'running' ? (
                  <Button size="sm" loading={actionId === `${s.id}-Deploy`} onClick={() => action(s.id, 'Deploy', () => api.deployStack(s.id))}>
                    <Play size={12} /> Deploy
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" loading={actionId === `${s.id}-Stop`} onClick={() => action(s.id, 'Stop', () => api.stopStack(s.id))}>
                    <Square size={12} /> Stop
                  </Button>
                )}
                <Button size="sm" variant="danger" onClick={() => action(s.id, 'Delete', () => api.deleteStack(s.id))}>
                  <Trash2 size={12} />
                </Button>
              </div>
            </div>
          </Card>
        ))
      }

      <StackModal open={showCreate || !!editStack} stack={editStack} onClose={() => { setShowCreate(false); setEditStack(null); }} onSaved={fetchStacks} />
      
      {/* Stack Logs Modal */}
      <Modal open={!!viewStack} onClose={() => { setViewStack(null); setStackLogs(''); }} title={viewStack ? `Logs: ${viewStack.name}` : 'Stack Logs'} width={800}>
        <LogViewer lines={stackLogs.split('\n').filter(Boolean)} height={400} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
          <Button size="sm" variant="secondary" onClick={() => viewStack && viewStackLogs(viewStack)}>
            <RefreshCw size={12} /> Refresh
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function StackModal({ open, stack, onClose, onSaved }) {
  const addToast = useStore(s => s.addToast);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [compose_content, setCompose] = useState(DEFAULT_COMPOSE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [validation, setValidation] = useState(null);
  const [validating, setValidating] = useState(false);

  useEffect(() => {
    if (stack) { setName(stack.name); setDescription(stack.description || ''); setCompose(stack.compose_content); }
    else { setName(''); setDescription(''); setCompose(DEFAULT_COMPOSE); }
    setError('');
    setValidation(null);
  }, [stack, open]);

  // Validate compose content on change (debounced)
  useEffect(() => {
    if (!compose_content.trim()) { setValidation(null); return; }
    
    const timer = setTimeout(async () => {
      setValidating(true);
      try {
        const result = await api.validateStack(compose_content);
        setValidation(result);
      } catch (e) {
        // Ignore validation errors, they'll show on save
      }
      setValidating(false);
    }, 500);
    
    return () => clearTimeout(timer);
  }, [compose_content]);

  const handleSave = async () => {
    if (!name) return setError('Name is required');
    setLoading(true);
    try {
      if (stack) await api.updateStack(stack.id, { compose_content, description });
      else await api.createStack({ name, description, compose_content });
      addToast({ message: `Stack ${stack ? 'updated' : 'created'}` });
      onSaved(); onClose();
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  return (
    <Modal open={open} onClose={onClose} title={stack ? `Edit: ${stack.name}` : 'Create Stack'} width={700}>
      {error && <div style={{ background: 'var(--red-dim)', border: '1px solid rgba(255,77,109,0.3)', color: 'var(--red)', padding: '10px 14px', borderRadius: 'var(--radius)', marginBottom: '16px', fontSize: '13px' }}>{error}</div>}
      
      {/* Validation warnings */}
      {validation?.warnings?.length > 0 && (
        <div style={{ background: 'rgba(245,166,35,0.1)', border: '1px solid rgba(245,166,35,0.3)', color: '#f5a623', padding: '10px 14px', borderRadius: 'var(--radius)', marginBottom: '16px', fontSize: '13px' }}>
          <strong>⚠️ Podman Compatibility Warnings:</strong>
          <ul style={{ margin: '8px 0 0 16px', padding: 0 }}>
            {validation.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      
      {!stack && <FormField label="Name"><input value={name} onChange={e => setName(e.target.value)} placeholder="my-stack" /></FormField>}
      <FormField label="Description"><input value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional description" /></FormField>
      <FormField label="docker-compose.yml">
        <textarea value={compose_content} onChange={e => setCompose(e.target.value)} style={{ fontFamily: 'var(--mono)', fontSize: '12px', minHeight: 300 }} />
        {validating && <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Validating...</span>}
      </FormField>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} loading={loading}>Save Stack</Button>
      </div>
    </Modal>
  );
}

const DEFAULT_COMPOSE = `version: '3.8'
services:
  app:
    image: nginx:alpine
    ports:
      - "8080:80"
    restart: unless-stopped
`;

// ── Containers Page ──────────────────────────────────────────────────────────
export function ContainersPage() {
  const { addToast } = useStore();
  const [containers, setContainers] = useState([]);
  const [managedIds, setManagedIds] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [containerToDelete, setContainerToDelete] = useState(null);
  
  // Terminal state
  const [showTerminal, setShowTerminal] = useState(false);
  const [terminalContainer, setTerminalContainer] = useState(null);
  const [terminalData, setTerminalData] = useState([]);
  const [terminalConnected, setTerminalConnected] = useState(false);
  const terminalSession = React.useRef(null);

  const fetch = async () => {
    setLoading(true);
    try {
      // Fetch all containers and external containers in parallel
      const [all, external] = await Promise.all([
        api.getContainers(),
        api.getExternalContainers().catch(() => []),
      ]);
      
      setContainers(all || []);
      
      // Build set of external container IDs (these can be deleted)
      const externalIds = new Set((external || []).map(c => c.Id || c.id));
      setManagedIds(externalIds);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { fetch(); }, []);
  
  // Cleanup terminal on unmount
  useEffect(() => {
    return () => {
      if (terminalSession.current) {
        terminalSession.current.close();
      }
    };
  }, []);
  
  const openTerminal = (container) => {
    const state = container.State?.Status || container.state;
    if (state !== 'running') {
      addToast({ message: 'Container must be running to open terminal', type: 'error' });
      return;
    }
    
    const name = (container.Names?.[0] || container.Id?.substring(0, 12) || '').replace(/^\//, '');
    setTerminalContainer({ ...container, displayName: name });
    setTerminalData([]);
    setTerminalConnected(false);
    setShowTerminal(true);
    
    // Create terminal session
    const session = api.createTerminal(
      container.Id || container.id,
      (data) => {
        // Received data
        setTerminalData(prev => [...prev.slice(-500), data]);
      },
      (msg) => {
        // Connection closed or error
        setTerminalConnected(false);
        if (msg.type === 'exit') {
          addToast({ message: 'Terminal session ended', type: 'success' });
        } else if (msg.type === 'error') {
          addToast({ message: msg.message || 'Terminal error', type: 'error' });
        }
      }
    );
    
    terminalSession.current = session;
    setTerminalConnected(true);
  };
  
  const closeTerminal = () => {
    if (terminalSession.current) {
      terminalSession.current.close();
      terminalSession.current = null;
    }
    setShowTerminal(false);
    setTerminalContainer(null);
    setTerminalData([]);
    setTerminalConnected(false);
  };
  
  const sendTerminalInput = (data) => {
    if (terminalSession.current && terminalConnected) {
      terminalSession.current.send(data);
    }
  };

  const getStateColor = (s) => ({
    running: 'var(--accent)', exited: 'var(--red)', created: 'var(--blue)', paused: 'var(--yellow)'
  })[s] || 'var(--text3)';
  
  const isExternal = (container) => {
    const id = container.Id || container.id;
    return managedIds.has(id);
  };
  
  const confirmDelete = (container) => {
    const name = (container.Names?.[0] || container.Id?.substring(0, 12) || 'unknown').replace(/^\//, '');
    setContainerToDelete({ ...container, displayName: name });
    setShowDeleteModal(true);
  };
  
  const handleDelete = async () => {
    if (!containerToDelete) return;
    
    setDeletingId(containerToDelete.Id || containerToDelete.id);
    setShowDeleteModal(false);
    
    try {
      await api.deleteContainer(containerToDelete.Id || containerToDelete.id);
      addToast({ message: `Container ${containerToDelete.displayName} deleted`, type: 'success' });
      await fetch();
    } catch (e) {
      addToast({ message: e.message, type: 'error' });
    }
    
    setDeletingId(null);
    setContainerToDelete(null);
  };

  const externalCount = containers.filter(isExternal).length;
  const runningCount = containers.filter(c => (c.State?.Status || c.state) === 'running').length;

  return (
    <div style={{ padding: '32px', maxWidth: 1100, animation: 'fadeIn 0.2s ease' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '28px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text)', marginBottom: '4px' }}>Containers</h1>
          <p style={{ color: 'var(--text3)', fontSize: '13px' }}>
            {containers.length} total • {runningCount} running • {externalCount} external
          </p>
        </div>
        <button onClick={fetch} style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer' }}>
          <RefreshCw size={16} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
        </button>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', padding: '60px' }}><Spinner /></div>
        : containers.length === 0 ? <EmptyState icon={Container} title="No containers" description="No containers found from Podman." />
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Name', 'Image', 'Status', 'Ports', 'Created', 'Actions'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: '11px', color: 'var(--text3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {containers.map(c => {
                  const canDelete = isExternal(c);
                  const name = (c.Names?.[0] || c.Id?.substring(0, 12) || '').replace(/^\//, '');
                  
                  return (
                    <tr key={c.Id} style={{ borderBottom: '1px solid var(--border)' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg3)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      <td style={{ padding: '10px 12px', fontSize: '13px', fontFamily: 'var(--mono)', color: 'var(--text)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {name}
                          {!canDelete && (
                            <span style={{ 
                              fontSize: '10px', 
                              color: 'var(--accent)', 
                              background: 'var(--accent-dim)', 
                              padding: '2px 6px', 
                              borderRadius: 4 
                            }}>
                              Managed
                            </span>
                          )}
                          {canDelete && (
                            <span style={{ 
                              fontSize: '10px', 
                              color: 'var(--text3)', 
                              background: 'var(--bg4)', 
                              padding: '2px 6px', 
                              borderRadius: 4 
                            }}>
                              External
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: '10px 12px', fontSize: '12px', color: 'var(--text2)', fontFamily: 'var(--mono)', maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.Image}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <span style={{ fontSize: '11px', fontFamily: 'var(--mono)', color: getStateColor(c.State?.Status || c.state), textTransform: 'uppercase' }}>⬤ {c.State?.Status || c.state}</span>
                      </td>
                      <td style={{ padding: '10px 12px', fontSize: '12px', color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                        {(c.Ports || []).filter(p => p.host_port).map(p => `${p.host_port}→${p.container_port}`).join(', ') || '—'}
                      </td>
                      <td style={{ padding: '10px 12px', fontSize: '12px', color: 'var(--text3)' }}>
                        {(() => {
                          if (!c.Created) return '—';
                          // Handle Unix timestamp (number or string)
                          let timestamp = c.Created;
                          if (typeof timestamp === 'number' || !isNaN(timestamp)) {
                            // If timestamp is less than year 3000 in seconds, it's probably seconds not milliseconds
                            timestamp = parseInt(timestamp);
                            if (timestamp < 32503680000) { // Year 3000 in seconds
                              timestamp *= 1000;
                            }
                          }
                          const date = new Date(timestamp);
                          return isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
                        })()}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {/* Terminal button - only for running containers */}
                          {(c.State?.Status || c.state) === 'running' && (
                            <Button 
                              size="sm" 
                              variant="secondary"
                              onClick={() => openTerminal(c)}
                              title="Open Terminal"
                            >
                              <TerminalIcon size={12} />
                            </Button>
                          )}
                          {canDelete && (
                            <Button 
                              size="sm" 
                              variant="danger" 
                              loading={deletingId === c.Id}
                              onClick={() => confirmDelete(c)}
                            >
                              <Trash2 size={12} />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      }
      
      {/* Delete Confirmation Modal */}
      <Modal 
        open={showDeleteModal} 
        onClose={() => setShowDeleteModal(false)} 
        title="Delete Container" 
        width={400}
      >
        <p style={{ color: 'var(--text2)', marginBottom: '24px', lineHeight: 1.6 }}>
          Are you sure you want to delete container <strong style={{ color: 'var(--text)' }}>{containerToDelete?.displayName}</strong>?
          <br /><br />
          This action cannot be undone.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <Button variant="secondary" onClick={() => setShowDeleteModal(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete} loading={deletingId !== null}>
            Delete Container
          </Button>
        </div>
      </Modal>
      
      {/* Terminal Modal */}
      <Modal
        open={showTerminal}
        onClose={closeTerminal}
        title={`Terminal: ${terminalContainer?.displayName || 'Container'}`}
        width={800}
      >
        <Terminal
          onData={terminalData}
          onInput={sendTerminalInput}
          connected={terminalConnected}
          containerName={terminalContainer?.displayName}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
          <Button variant="secondary" onClick={closeTerminal}>Close Terminal</Button>
        </div>
      </Modal>
    </div>
  );
}

// ── Deployments Page ─────────────────────────────────────────────────────────
export function DeploymentsPage() {
  const [deployments, setDeployments] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getDeployments({ limit: 50 }).then(d => { setDeployments(d || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  return (
    <div style={{ padding: '32px', maxWidth: 900, animation: 'fadeIn 0.2s ease' }}>
      <div style={{ marginBottom: '28px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text)', marginBottom: '4px' }}>Deployments</h1>
        <p style={{ color: 'var(--text3)', fontSize: '13px' }}>Recent deployment history</p>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', padding: '60px' }}><Spinner /></div>
        : deployments.length === 0 ? <EmptyState icon={Activity} title="No deployments" description="Deploy an app to see history here." />
        : deployments.map(d => (
          <div key={d.id} style={{ padding: '14px 0', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '16px' }}>
            <StatusBadge status={d.status} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text)' }}>{d.app_name}</span>
                {d.commit_sha && <Badge>{d.commit_sha}</Badge>}
              </div>
              {d.commit_message && <p style={{ fontSize: '12px', color: 'var(--text3)', marginTop: '2px' }}>{d.commit_message}</p>}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text3)', textAlign: 'right', flexShrink: 0 }}>
              <div>{new Date(d.started_at).toLocaleString()}</div>
              {d.finished_at && (
                <div style={{ color: 'var(--text3)' }}>{Math.round((new Date(d.finished_at) - new Date(d.started_at)) / 1000)}s</div>
              )}
            </div>
          </div>
        ))
      }
    </div>
  );
}

// ── Proxy Settings Card Component ─────────────────────────────────────────────
function ProxySettingsCard({ settings, set, onSave, saving }) {
  const [proxyTypes, setProxyTypes] = useState([]);
  const [proxyModes, setProxyModes] = useState([]);
  const [proxyStatus, setProxyStatus] = useState(null);
  const [containerStatus, setContainerStatus] = useState(null);
  const [testing, setTesting] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [guide, setGuide] = useState(null);
  const addToast = useStore(s => s.addToast);

  const proxyType = settings.proxy_type || 'caddy';
  const proxyMode = settings.proxy_mode || 'container';

  useEffect(() => {
    api.getProxyTypes().then(setProxyTypes).catch(() => {});
    api.getProxyModes().then(setProxyModes).catch(() => {});
    fetchProxyStatus();
    fetchContainerStatus();
  }, []);

  useEffect(() => {
    if (proxyType) {
      api.getProxyGuide(proxyType).then(setGuide).catch(() => {});
    }
  }, [proxyType]);

  const fetchProxyStatus = async () => {
    try {
      const status = await api.getProxyStatus();
      setProxyStatus(status);
    } catch {}
  };

  const fetchContainerStatus = async () => {
    if (proxyType === 'none' || proxyType === 'custom') return;
    try {
      const status = await api.getProxyContainerStatus();
      setContainerStatus(status);
    } catch {}
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await api.testProxy();
      setProxyStatus(result);
      addToast({ 
        message: result.available ? 'Proxy connection successful' : 'Proxy connection failed',
        type: result.available ? 'success' : 'error'
      });
    } catch (e) {
      addToast({ message: e.message, type: 'error' });
    }
    setTesting(false);
  };

  const handleDeployContainer = async () => {
    // Check if settings need to be saved first
    const currentConfig = await api.getProxyConfig();
    if (currentConfig.type !== proxyType) {
      addToast({ 
        message: 'Please save settings first before deploying (proxy type changed)',
        type: 'error'
      });
      setDeploying(false);
      return;
    }
    
    setDeploying(true);
    try {
      const result = await api.deployProxyContainer({ 
        force: containerStatus?.exists 
      });
      addToast({ 
        message: `Proxy container deployed: ${result.name}`,
        type: 'success'
      });
      await fetchContainerStatus();
      await fetchProxyStatus();
    } catch (e) {
      addToast({ message: e.message, type: 'error' });
    }
    setDeploying(false);
  };

  const handleRemoveContainer = async () => {
    try {
      await api.removeProxyContainer();
      addToast({ message: 'Proxy container removed', type: 'success' });
      await fetchContainerStatus();
    } catch (e) {
      addToast({ message: e.message, type: 'error' });
    }
  };

  const handleRestartContainer = async () => {
    try {
      await api.restartProxyContainer();
      addToast({ message: 'Proxy container restarted', type: 'success' });
      await fetchContainerStatus();
    } catch (e) {
      addToast({ message: e.message, type: 'error' });
    }
  };

  const handleStartContainer = async () => {
    try {
      const result = await api.startProxyContainer();
      addToast({ message: result.message, type: 'success' });
      await fetchContainerStatus();
    } catch (e) {
      addToast({ message: e.message, type: 'error' });
    }
  };

  const handleStopContainer = async () => {
    try {
      const result = await api.stopProxyContainer();
      addToast({ message: result.message, type: 'success' });
      await fetchContainerStatus();
    } catch (e) {
      addToast({ message: e.message, type: 'error' });
    }
  };

  const selectedType = proxyTypes.find(t => t.type === proxyType);
  const selectedMode = proxyModes.find(m => m.mode === proxyMode);

  // Auto-update defaults when type changes
  useEffect(() => {
    if (selectedType) {
      if (proxyMode === 'container' && selectedType.defaultContainerName) {
        set('proxy_container_name', selectedType.defaultContainerName);
        set('proxy_admin_url', `http://${selectedType.defaultContainerName}:${selectedType.type === 'traefik' ? '8080' : '2019'}`);
      }
    }
  }, [proxyType]);

  return (
    <Card style={{ marginBottom: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>Reverse Proxy</h3>
        {proxyStatus && (
          <StatusBadge status={proxyStatus.available ? 'running' : 'stopped'}>
            {proxyStatus.available ? 'Connected' : 'Disconnected'}
          </StatusBadge>
        )}
      </div>

      <FormField label="Proxy Type" hint={selectedType?.description}>
        <select 
          value={proxyType} 
          onChange={e => set('proxy_type', e.target.value)}
        >
          {proxyTypes.map(t => (
            <option key={t.type} value={t.type}>{t.name}</option>
          ))}
        </select>
      </FormField>

      {/* Deployment Mode */}
      {proxyType !== 'none' && proxyType !== 'custom' && (
        <FormField label="Deployment Mode" hint={selectedMode?.description}>
          <select 
            value={proxyMode} 
            onChange={e => set('proxy_mode', e.target.value)}
          >
            {proxyModes.map(m => (
              <option key={m.mode} value={m.mode}>{m.name}</option>
            ))}
          </select>
          {selectedMode && (
            <p style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '4px' }}>
              {selectedMode.details}
            </p>
          )}
        </FormField>
      )}

      {/* Container Mode Configuration */}
      {proxyMode === 'container' && proxyType !== 'none' && proxyType !== 'custom' && (
        <>
          <FormField label="Container Name" hint="Name of the proxy container">
            <input 
              value={settings.proxy_container_name || selectedType?.defaultContainerName || ''} 
              onChange={e => set('proxy_container_name', e.target.value)} 
            />
          </FormField>
          <FormField label="Podman Network" hint="Network where containers can communicate">
            <input 
              value={settings.proxy_podman_network || 'podman-paas'} 
              onChange={e => set('proxy_podman_network', e.target.value)} 
            />
          </FormField>
          {(proxyType === 'caddy' || proxyType === 'traefik') && (
            <FormField label="Admin API URL" hint="Internal URL for proxy management">
              <input 
                value={settings.proxy_admin_url || `http://${selectedType?.defaultContainerName || proxyType}:${proxyType === 'traefik' ? '8080' : '2019'}`} 
                onChange={e => set('proxy_admin_url', e.target.value)} 
              />
            </FormField>
          )}
          {proxyType === 'nginx' && (
            <FormField label="Config Volume" hint="Path mounted to container's nginx conf.d">
              <input 
                value={settings.proxy_config_path || '/etc/nginx/conf.d'} 
                onChange={e => set('proxy_config_path', e.target.value)} 
              />
            </FormField>
          )}
        </>
      )}

      {/* Remote Mode Configuration */}
      {proxyMode === 'remote' && proxyType !== 'none' && proxyType !== 'custom' && (
        <>
          <div style={{ padding: '12px', background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.3)', borderRadius: 'var(--radius)', marginBottom: '16px' }}>
            <p style={{ fontSize: '12px', color: '#38bdf8', margin: 0 }}>
              <strong>Remote Mode:</strong> The proxy runs on a different server.
              Ensure VPN/P2P connectivity (Tailscale, ZeroTier, WireGuard) between the proxy server and this host.
            </p>
          </div>
          <FormField label="Remote Host/IP" hint="Hostname or IP accessible from proxy server">
            <input 
              value={settings.proxy_remote_host || ''} 
              onChange={e => set('proxy_remote_host', e.target.value)} 
              placeholder="e.g., 100.64.0.1 (Tailscale) or 10.0.0.5"
            />
          </FormField>
          {(proxyType === 'caddy' || proxyType === 'traefik') && (
            <FormField label="Admin API URL" hint="URL accessible from Podman PaaS">
              <input 
                value={settings.proxy_admin_url || ''} 
                onChange={e => set('proxy_admin_url', e.target.value)} 
                placeholder="e.g., http://proxy-server:2019"
              />
            </FormField>
          )}
        </>
      )}

      {/* Host Mode Configuration */}
      {proxyMode === 'host' && proxyType !== 'none' && proxyType !== 'custom' && (
        <>
          {(proxyType === 'caddy' || proxyType === 'traefik') && (
            <FormField label="Admin API URL" hint={`${selectedType?.name || proxyType} admin API endpoint`}>
              <input 
                value={settings.proxy_admin_url || 'http://localhost:2019'} 
                onChange={e => set('proxy_admin_url', e.target.value)} 
              />
            </FormField>
          )}
          {proxyType === 'nginx' && (
            <>
              <FormField label="Config Directory" hint="Where nginx config files are stored">
                <input 
                  value={settings.proxy_config_path || '/etc/nginx/conf.d'} 
                  onChange={e => set('proxy_config_path', e.target.value)} 
                />
              </FormField>
              <div style={{ padding: '12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', marginBottom: '16px' }}>
                <p style={{ fontSize: '12px', color: 'var(--text3)', margin: 0 }}>
                  <strong>Note:</strong> Podman PaaS needs write access to this directory.
                  Run: <code>sudo chown $USER /etc/nginx/conf.d</code>
                </p>
              </div>
            </>
          )}
        </>
      )}

      {proxyType === 'custom' && (
        <div style={{ padding: '12px', background: 'rgba(245,166,35,0.1)', border: '1px solid rgba(245,166,35,0.3)', borderRadius: 'var(--radius)', marginBottom: '16px' }}>
          <p style={{ fontSize: '12px', color: '#f5a623', margin: 0 }}>
            <strong>Custom Proxy:</strong> You are using your own reverse proxy.
            Podman PaaS will not manage proxy configuration. 
            Apps will be accessible via assigned ports.
          </p>
        </div>
      )}

      {proxyType === 'none' && (
        <div style={{ padding: '12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', marginBottom: '16px' }}>
          <p style={{ fontSize: '12px', color: 'var(--text3)', margin: 0 }}>
            <strong>Proxy Disabled:</strong> Apps will only be accessible via their assigned ports.
            No automatic domain routing will be configured.
          </p>
        </div>
      )}

      {/* Container Management */}
      {proxyMode === 'container' && proxyType !== 'none' && proxyType !== 'custom' && (
        <div style={{ 
          padding: '16px', 
          background: 'var(--bg-secondary)', 
          borderRadius: 'var(--radius)', 
          marginBottom: '16px',
          border: '1px solid var(--border)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h4 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)', margin: 0 }}>
              Container Status
            </h4>
            {containerStatus?.exists ? (
              <StatusBadge status={containerStatus.running ? 'running' : 'stopped'}>
                {containerStatus.running ? 'Running' : 'Stopped'}
              </StatusBadge>
            ) : (
              <Badge variant="secondary">Not Deployed</Badge>
            )}
          </div>
          
          {containerStatus?.exists ? (
            <>
              <p style={{ fontSize: '12px', color: 'var(--text3)', margin: '0 0 12px 0' }}>
                Container: <code>{containerStatus.name}</code> | ID: <code>{containerStatus.id?.substring(0, 12)}</code>
              </p>
              {containerStatus.ports && (
                <p style={{ fontSize: '11px', color: 'var(--text3)', margin: '0 0 12px 0' }}>
                  Ports: HTTP={containerStatus.ports.http}, HTTPS={containerStatus.ports.https}
                  {containerStatus.ports.admin && `, Admin=${containerStatus.ports.admin}`}
                </p>
              )}
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {containerStatus.running ? (
                  <Button size="sm" variant="secondary" onClick={handleStopContainer}>
                    <Square size={12} /> Stop
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" onClick={handleStartContainer}>
                    <Play size={12} /> Start
                  </Button>
                )}
                <Button size="sm" variant="secondary" onClick={handleRestartContainer}>
                  <RefreshCw size={12} /> Restart
                </Button>
                <Button size="sm" onClick={handleDeployContainer} loading={deploying}>
                  <Download size={12} /> Update
                </Button>
                <Button size="sm" variant="danger" onClick={handleRemoveContainer}>
                  <Trash2 size={12} /> Remove
                </Button>
              </div>
            </>
          ) : (
            <>
              <p style={{ fontSize: '12px', color: 'var(--text3)', margin: '0 0 8px 0' }}>
                No proxy container found. Deploy to automatically pull and configure {proxyType}.
              </p>
              <p style={{ fontSize: '11px', color: 'var(--text3)', margin: '0 0 12px 0' }}>
                <strong>Note:</strong> In rootless mode, ports 8080 (HTTP) and 8443 (HTTPS) will be used instead of 80/443.
              </p>
              <Button size="sm" onClick={handleDeployContainer} loading={deploying}>
                <Download size={12} /> Deploy {selectedType?.name || proxyType} Container
              </Button>
            </>
          )}
        </div>
      )}

      {/* Setup Guide */}
      {guide && proxyType !== 'none' && proxyType !== 'custom' && (
        <div style={{ marginBottom: '16px' }}>
          <details>
            <summary style={{ cursor: 'pointer', fontSize: '13px', color: 'var(--text2)' }}>
              Setup Guide for {guide.name}
            </summary>
            <div style={{ padding: '12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', marginTop: '8px' }}>
              {guide.install && (
                <>
                  <p style={{ fontSize: '12px', fontWeight: 600, margin: '0 0 8px 0' }}>Installation:</p>
                  <pre style={{ fontSize: '11px', overflow: 'auto', padding: '8px', background: 'var(--bg)', borderRadius: '4px' }}>
                    {Object.entries(guide.install).map(([k, v]) => `${k}: ${v}`).join('\n')}
                  </pre>
                </>
              )}
              {guide.setup && (
                <>
                  <p style={{ fontSize: '12px', fontWeight: 600, margin: '12px 0 8px 0' }}>Setup Steps:</p>
                  <ol style={{ fontSize: '11px', color: 'var(--text2)', margin: 0, paddingLeft: '16px' }}>
                    {guide.setup.map((step, i) => <li key={i} style={{ marginBottom: '4px' }}>{step}</li>)}
                  </ol>
                </>
              )}
            </div>
          </details>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Button size="sm" variant="secondary" onClick={handleTest} loading={testing}>
          Test Connection
        </Button>
        <Button onClick={onSave} loading={saving}>Save Settings</Button>
      </div>
    </Card>
  );
}

// ── Settings Page ─────────────────────────────────────────────────────────────
export function SettingsPage() {
  const addToast = useStore(s => s.addToast);
  const user = useStore(s => s.user);
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Password change
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwLoading, setPwLoading] = useState(false);

  // Users
  const [users, setUsers] = useState([]);
  const [newUsername, setNewUsername] = useState('');
  const [newUserPw, setNewUserPw] = useState('');
  const [userLoading, setUserLoading] = useState(false);

  // Backup
  const [backupLoading, setBackupLoading] = useState(false);
  const [importLoading, setImportLoading] = useState(false);

  useEffect(() => {
    api.getSettings().then(s => { setSettings(s); setLoading(false); }).catch(() => setLoading(false));
    api.getUsers().then(u => setUsers(u || [])).catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try { await api.updateSettings(settings); addToast({ message: 'Settings saved' }); }
    catch (e) { addToast({ message: e.message, type: 'error' }); }
    setSaving(false);
  };

  const handleChangePassword = async () => {
    if (!currentPw || !newPw) return addToast({ message: 'Fill in both fields', type: 'error' });
    if (newPw.length < 8) return addToast({ message: 'New password must be at least 8 characters', type: 'error' });
    setPwLoading(true);
    try {
      await api.changePassword({ current_password: currentPw, new_password: newPw });
      addToast({ message: 'Password changed' });
      setCurrentPw(''); setNewPw('');
    } catch (e) { addToast({ message: e.message, type: 'error' }); }
    setPwLoading(false);
  };

  const handleCreateUser = async () => {
    if (!newUsername || !newUserPw) return addToast({ message: 'Fill in username and password', type: 'error' });
    setUserLoading(true);
    try {
      await api.createUser({ username: newUsername, password: newUserPw });
      addToast({ message: `User "${newUsername}" created` });
      setNewUsername(''); setNewUserPw('');
      const u = await api.getUsers(); setUsers(u || []);
    } catch (e) { addToast({ message: e.message, type: 'error' }); }
    setUserLoading(false);
  };

  const handleDeleteUser = async (id, username) => {
    try {
      await api.deleteUser(id);
      addToast({ message: `User "${username}" deleted` });
      setUsers(u => u.filter(x => x.id !== id));
    } catch (e) { addToast({ message: e.message, type: 'error' }); }
  };

  const handleExport = async () => {
    setBackupLoading(true);
    try {
      const blob = await api.exportBackup();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `podpaas-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      addToast({ message: 'Backup downloaded' });
    } catch (e) { addToast({ message: e.message, type: 'error' }); }
    setBackupLoading(false);
  };

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportLoading(true);
    try {
      await api.importBackup(file);
      addToast({ message: 'Backup imported. Restart server for full effect.' });
    } catch (err) { addToast({ message: err.message, type: 'error' }); }
    setImportLoading(false);
    e.target.value = '';
  };

  const set = (k, v) => setSettings(s => ({ ...s, [k]: v }));

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: '60px' }}><Spinner /></div>;

  return (
    <div style={{ padding: '32px', maxWidth: 700, animation: 'fadeIn 0.2s ease' }}>
      <div style={{ marginBottom: '28px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text)', marginBottom: '4px' }}>Settings</h1>
        <p style={{ color: 'var(--text3)', fontSize: '13px' }}>Platform configuration</p>
      </div>

      {/* Account */}
      <Card style={{ marginBottom: '16px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Key size={16} /> Account
        </h3>
        {user && <p style={{ fontSize: '13px', color: 'var(--text2)', marginBottom: '16px' }}>Logged in as <strong>{user.username}</strong></p>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <FormField label="Current Password">
            <input type="password" value={currentPw} onChange={e => setCurrentPw(e.target.value)} />
          </FormField>
          <FormField label="New Password">
            <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} placeholder="min 8 characters" />
          </FormField>
        </div>
        <Button size="sm" onClick={handleChangePassword} loading={pwLoading}>Change Password</Button>
      </Card>

      {/* Users */}
      <Card style={{ marginBottom: '16px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Users size={16} /> Users
        </h3>
        {users.map(u => (
          <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <div>
              <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text)' }}>{u.username}</span>
              <span style={{ fontSize: '11px', color: 'var(--text3)', marginLeft: '8px' }}>{new Date(u.created_at).toLocaleDateString()}</span>
            </div>
            {u.id !== user?.id && (
              <Button size="sm" variant="danger" onClick={() => handleDeleteUser(u.id, u.username)}>
                <Trash2 size={12} />
              </Button>
            )}
          </div>
        ))}
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px', alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <FormField label="Username">
              <input value={newUsername} onChange={e => setNewUsername(e.target.value)} placeholder="newuser" />
            </FormField>
          </div>
          <div style={{ flex: 1 }}>
            <FormField label="Password">
              <input type="password" value={newUserPw} onChange={e => setNewUserPw(e.target.value)} placeholder="min 8 chars" />
            </FormField>
          </div>
          <div style={{ marginBottom: '16px' }}>
            <Button size="sm" onClick={handleCreateUser} loading={userLoading}>
              <Plus size={12} /> Add
            </Button>
          </div>
        </div>
      </Card>

      {/* Reverse Proxy */}
      <ProxySettingsCard settings={settings} set={set} onSave={handleSave} saving={saving} />

      {/* Infrastructure */}
      <Card style={{ marginBottom: '16px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '20px' }}>Infrastructure</h3>
        <FormField label="Podman Socket Path" hint="Unix socket path for Podman API (rootless: /run/user/1000/podman/podman.sock)">
          <input value={settings.podman_socket || ''} onChange={e => set('podman_socket', e.target.value)} />
        </FormField>
        <FormField label="Domain Suffix" hint="Auto-assigned domain suffix (e.g. .localhost or .myserver.com)">
          <input value={settings.domain_suffix || ''} onChange={e => set('domain_suffix', e.target.value)} />
        </FormField>
        <FormField label="Rootless Mode">
          <select value={settings.rootless || 'true'} onChange={e => set('rootless', e.target.value)}>
            <option value="true">Yes (recommended)</option>
            <option value="false">No (rootful)</option>
          </select>
        </FormField>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={handleSave} loading={saving}>Save Settings</Button>
        </div>
      </Card>

      {/* Backup & Restore */}
      <Card>
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Download size={16} /> Backup & Restore
        </h3>
        <p style={{ fontSize: '13px', color: 'var(--text3)', marginBottom: '16px' }}>
          Export a ZIP backup of the database and all stack configurations, or import a previous backup.
        </p>
        <div style={{ display: 'flex', gap: '10px' }}>
          <Button variant="secondary" onClick={handleExport} loading={backupLoading}>
            <Download size={14} /> Export Backup
          </Button>
          <label>
            <Button variant="secondary" loading={importLoading} onClick={() => document.getElementById('backup-import').click()}>
              <Upload size={14} /> Import Backup
            </Button>
            <input id="backup-import" type="file" accept=".zip" onChange={handleImport} style={{ display: 'none' }} />
          </label>
        </div>
      </Card>
    </div>
  );
}

// ── Login Page ────────────────────────────────────────────────────────────────
export function LoginPage() {
  const navigate = useNavigate();
  const setToken = useStore(s => s.setToken);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!username || !password) return setError('Fill in all fields');
    setLoading(true);
    setError('');
    try {
      const { token } = await api.login(username, password);
      setToken(token);
      navigate('/');
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)',
      backgroundImage: 'radial-gradient(ellipse at 30% 20%, rgba(0,212,170,0.06) 0%, transparent 50%), radial-gradient(ellipse at 70% 80%, rgba(59,158,255,0.05) 0%, transparent 50%)',
    }}>
      <div style={{ width: '100%', maxWidth: 380, padding: '20px' }}>
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div style={{
            width: 52, height: 52, background: 'var(--accent)', borderRadius: '14px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px', fontSize: '24px'
          }}>⬡</div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--text)', marginBottom: '6px' }}>PodPaaS</h1>
          <p style={{ color: 'var(--text3)', fontSize: '13px' }}>Podman-powered platform</p>
        </div>

        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '28px' }}>
          {error && <div style={{ background: 'var(--red-dim)', border: '1px solid rgba(255,77,109,0.3)', color: 'var(--red)', padding: '10px 14px', borderRadius: 'var(--radius)', marginBottom: '16px', fontSize: '13px' }}>{error}</div>}

          <FormField label="Username">
            <input value={username} onChange={e => setUsername(e.target.value)} placeholder="admin" onKeyDown={e => e.key === 'Enter' && handleLogin()} />
          </FormField>
          <FormField label="Password">
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" onKeyDown={e => e.key === 'Enter' && handleLogin()} />
          </FormField>

          <Button onClick={handleLogin} loading={loading} style={{ width: '100%', justifyContent: 'center', marginTop: '8px' }}>
            Sign In
          </Button>
        </div>

        <p style={{ textAlign: 'center', fontSize: '12px', color: 'var(--text3)', marginTop: '16px' }}>
          Default: admin / admin
        </p>
      </div>
    </div>
  );
}
