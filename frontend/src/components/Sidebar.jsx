import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Boxes, Layers, Activity, Settings, LogOut, Container, LayoutTemplate } from 'lucide-react';
import { useStore } from '../lib/store.js';

const NAV = [
  { to: '/',            icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/apps',        icon: Boxes,           label: 'Apps' },
  { to: '/stacks',      icon: Layers,          label: 'Stacks' },
  { to: '/templates',   icon: LayoutTemplate,  label: 'Templates' },
  { to: '/containers',  icon: Container,       label: 'Containers' },
  { to: '/deployments', icon: Activity,        label: 'Deployments' },
  { to: '/settings',    icon: Settings,        label: 'Settings' },
];

export default function Sidebar() {
  const logout = useStore(s => s.logout);
  const navigate = useNavigate();
  const handleLogout = () => { logout(); navigate('/login'); };

  return (
    <aside style={{
      width: 220, minHeight: '100vh', flexShrink: 0,
      background: 'var(--bg2)', borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      position: 'sticky', top: 0, height: '100vh',
    }}>
      {/* Logo */}
      <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: 32, height: 32, background: 'var(--accent)',
            borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{ fontSize: '16px' }}>⬡</span>
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '14px', fontFamily: 'var(--mono)', color: 'var(--text)' }}>PodPaaS</div>
            <div style={{ fontSize: '10px', color: 'var(--text3)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Podman Platform</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}
            style={({ isActive }) => ({
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '8px 12px', borderRadius: 'var(--radius)',
              fontSize: '13px', fontWeight: 500,
              color: isActive ? 'var(--text)' : 'var(--text3)',
              background: isActive ? 'var(--bg3)' : 'transparent',
              textDecoration: 'none',
              transition: 'all 0.15s',
              border: isActive ? '1px solid var(--border2)' : '1px solid transparent',
              outline: 'none',
              boxShadow: 'none',
            })}
          >
            <Icon size={15} />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div style={{ padding: '12px 10px', borderTop: '1px solid var(--border)' }}>
        <button
          onClick={handleLogout}
          style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            width: '100%', padding: '8px 12px', borderRadius: 'var(--radius)',
            background: 'none', border: 'none', color: 'var(--text3)',
            fontSize: '13px', fontWeight: 500, cursor: 'pointer',
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--red)'; e.currentTarget.style.background = 'var(--red-dim)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--text3)'; e.currentTarget.style.background = 'none'; }}
        >
          <LogOut size={15} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
