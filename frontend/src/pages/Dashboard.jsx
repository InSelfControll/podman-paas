import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Boxes, Activity, Layers, Server, Wifi, WifiOff, TrendingUp, Clock, Container } from 'lucide-react';
import { useStore } from '../lib/store.js';
import { api } from '../lib/api.js';
import { Card, StatusBadge, Spinner, Badge, Button } from '../components/ui.jsx';

function StatCard({ icon: Icon, label, value, sub, color = 'var(--accent)', onClick }) {
  return (
    <Card style={{ cursor: onClick ? 'pointer' : 'default' }} onClick={onClick}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>{label}</div>
          <div style={{ fontSize: '28px', fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--text)', lineHeight: 1 }}>{value}</div>
          {sub && <div style={{ fontSize: '12px', color: 'var(--text3)', marginTop: '6px' }}>{sub}</div>}
        </div>
        <div style={{
          width: 40, height: 40, borderRadius: '10px',
          background: `${color}18`, border: `1px solid ${color}30`,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <Icon size={18} style={{ color }} />
        </div>
      </div>
    </Card>
  );
}

function ServiceDot({ label, status }) {
  const ok = status === 'online';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '8px 14px', background: 'var(--bg3)',
      border: `1px solid ${ok ? 'var(--accent-border)' : 'rgba(255,77,109,0.2)'}`,
      borderRadius: 'var(--radius)', fontSize: '12px',
      color: ok ? 'var(--accent)' : 'var(--red)',
    }}>
      {ok ? <Wifi size={13} /> : <WifiOff size={13} />}
      <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{label}</span>
      <span style={{ marginLeft: 'auto', opacity: 0.7 }}>{status}</span>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { overview, apps, fetchOverview, fetchApps } = useStore();
  const [externalContainers, setExternalContainers] = useState([]);

  useEffect(() => {
    fetchOverview();
    fetchApps();
    fetchExternalContainers();
    const id = setInterval(() => {
      fetchOverview();
      fetchExternalContainers();
    }, 15000);
    return () => clearInterval(id);
  }, []);
  
  const fetchExternalContainers = async () => {
    try {
      const containers = await api.getExternalContainers();
      setExternalContainers(containers || []);
    } catch (e) {
      console.error('Failed to fetch external containers:', e);
    }
  };

  const runningApps = apps.filter(a => a.status === 'running');
  const recentApps = [...apps].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 5);
  
  const runningExternal = externalContainers.filter(c => (c.State?.Status || c.state) === 'running');

  return (
    <div style={{ padding: '32px', maxWidth: 1100, animation: 'fadeIn 0.2s ease' }}>
      <div style={{ marginBottom: '28px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text)', marginBottom: '4px' }}>Dashboard</h1>
        <p style={{ color: 'var(--text3)', fontSize: '13px' }}>System overview and status</p>
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', marginBottom: '28px' }}>
        <StatCard 
          icon={Boxes} 
          label="Apps" 
          value={overview?.apps?.total ?? '—'} 
          sub={`${overview?.apps?.running ?? 0} running`} 
          color="var(--accent)" 
          onClick={() => navigate('/apps')}
        />
        <StatCard 
          icon={Layers} 
          label="Stacks" 
          value={overview?.stacks?.total ?? '—'} 
          sub={`${overview?.stacks?.running ?? 0} running`} 
          color="var(--purple)" 
          onClick={() => navigate('/stacks')}
        />
        <StatCard 
          icon={Container} 
          label="Containers" 
          value={overview?.containers?.total ?? '—'} 
          sub={`${overview?.containers?.running ?? 0} running`} 
          color="var(--blue)" 
          onClick={() => navigate('/containers')}
        />
        <StatCard 
          icon={Activity} 
          label="Deploys (24h)" 
          value={overview?.deployments_24h ?? '—'} 
          color="var(--yellow)" 
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: '20px' }}>
        {/* Left column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Recent apps */}
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
              <h2 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>Recent Apps</h2>
              <button onClick={() => navigate('/apps')} style={{
                background: 'none', border: 'none', color: 'var(--accent)', fontSize: '12px', cursor: 'pointer'
              }}>View all →</button>
            </div>

            {recentApps.length === 0
              ? <p style={{ color: 'var(--text3)', fontSize: '13px' }}>No apps yet.</p>
              : recentApps.map(app => (
                <div key={app.id}
                  onClick={() => navigate(`/apps/${app.id}`)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 0', borderBottom: '1px solid var(--border)',
                    cursor: 'pointer', transition: 'opacity 0.15s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.opacity = '0.7'}
                  onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: '8px',
                      background: 'var(--bg4)', border: '1px solid var(--border)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '14px', fontFamily: 'var(--mono)', color: 'var(--accent)'
                    }}>
                      {app.name[0].toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text)' }}>{app.name}</div>
                      {app.domain && <div style={{ fontSize: '11px', color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{app.domain}</div>}
                    </div>
                  </div>
                  <StatusBadge status={app.status} />
                </div>
              ))
            }
          </Card>
          
          {/* External Containers (not managed by PodPaaS) */}
          {externalContainers.length > 0 && (
            <Card>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
                <h2 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>
                  External Containers ({runningExternal.length} running)
                </h2>
                <span style={{ fontSize: '11px', color: 'var(--text3)' }}>Not managed by PodPaaS</span>
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {externalContainers.slice(0, 5).map(container => {
                  const name = (container.Names?.[0] || container.Id?.substring(0, 12) || 'unknown').replace(/^\//, '');
                  const status = container.State?.Status || container.state || 'unknown';
                  const isRunning = status === 'running';
                  
                  return (
                    <div key={container.Id} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '10px 12px', background: 'var(--bg3)', borderRadius: 'var(--radius)',
                      border: '1px solid var(--border)'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{
                          width: 8, height: 8, borderRadius: '50%',
                          background: isRunning ? 'var(--accent)' : 'var(--red)'
                        }} />
                        <span style={{ fontSize: '12px', fontFamily: 'var(--mono)', color: 'var(--text)' }}>
                          {name}
                        </span>
                      </div>
                      <span style={{ 
                        fontSize: '11px', 
                        color: isRunning ? 'var(--accent)' : 'var(--red)',
                        textTransform: 'uppercase'
                      }}>
                        {status}
                      </span>
                    </div>
                  );
                })}
                {externalContainers.length > 5 && (
                  <Button size="sm" variant="ghost" onClick={() => navigate('/containers')}>
                    View all {externalContainers.length} containers →
                  </Button>
                )}
              </div>
            </Card>
          )}
        </div>

        {/* Right column - Services & System */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <Card>
            <h2 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '14px' }}>Services</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <ServiceDot label="Podman" status={overview?.services?.podman || 'offline'} />
              {overview?.services?.proxy_type && overview.services.proxy_type !== 'none' && (
                <ServiceDot 
                  label={overview.services.proxy_type.charAt(0).toUpperCase() + overview.services.proxy_type.slice(1)} 
                  status={overview?.services?.proxy || 'offline'} 
                />
              )}
              {(!overview?.services?.proxy_type || overview.services.proxy_type === 'none') && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '8px 14px', background: 'var(--bg3)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)', fontSize: '12px',
                  color: 'var(--text3)',
                }}>
                  <WifiOff size={13} />
                  <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>Proxy</span>
                  <span style={{ marginLeft: 'auto', opacity: 0.7 }}>disabled</span>
                </div>
              )}
            </div>
          </Card>
          
          {/* Quick Stats */}
          <Card>
            <h2 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '14px' }}>Overview</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {[
                ['Apps Running', overview?.apps?.running, overview?.apps?.total],
                ['Stacks Running', overview?.stacks?.running, overview?.stacks?.total],
                ['Containers Running', overview?.containers?.running, overview?.containers?.total],
                ['External Containers', externalContainers.length, null],
              ].map(([label, value, total]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                  <span style={{ color: 'var(--text3)' }}>{label}</span>
                  <span style={{ color: 'var(--text)', fontFamily: 'var(--mono)', fontWeight: 600 }}>
                    {value ?? '—'}{total !== null && total !== undefined && ` / ${total}`}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          {overview?.system && (
            <Card>
              <h2 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '14px' }}>System Info</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {[
                  ['OS', overview.system.os],
                  ['Kernel', overview.system.kernel],
                  ['Podman', overview.system.version],
                  ['Images', overview.system.images],
                ].map(([k, v]) => v && (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                    <span style={{ color: 'var(--text3)' }}>{k}</span>
                    <span style={{ color: 'var(--text2)', fontFamily: 'var(--mono)' }}>{v}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
