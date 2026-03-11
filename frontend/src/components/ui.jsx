import React from 'react';
import { clsx } from 'clsx';
import { X, Loader } from 'lucide-react';

// ── Button ──────────────────────────────────────────────────────────────────
export function Button({ children, variant = 'primary', size = 'md', loading, className, ...props }) {
  const base = 'inline-flex items-center gap-2 font-medium rounded transition-all duration-150 border';
  const variants = {
    primary: 'bg-accent text-white border-accent hover:bg-accent2 hover:border-accent2',
    secondary: 'bg-transparent text-text2 border-border hover:border-border2 hover:text-text',
    danger: 'bg-red-dim text-red border-red/30 hover:bg-red/20',
    ghost: 'bg-transparent text-text3 border-transparent hover:text-text2 hover:bg-bg3',
    success: 'bg-accent-dim text-accent border-accent-border hover:bg-accent/20',
  };
  const sizes = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm',
    lg: 'px-5 py-2.5 text-sm',
  };

  return (
    <button
      className={clsx(base, variants[variant], sizes[size], className)}
      style={{
        '--bg': 'var(--bg)', '--text-bg': 'var(--bg)',
        background: variant === 'primary' ? 'var(--accent)' :
          variant === 'danger' ? 'var(--red-dim)' :
          variant === 'success' ? 'var(--accent-dim)' :
          variant === 'secondary' ? 'transparent' : 'transparent',
        color: variant === 'primary' ? '#fff' :
          variant === 'danger' ? 'var(--red)' :
          variant === 'success' ? 'var(--accent)' :
          'var(--text2)',
        borderColor: variant === 'primary' ? 'var(--accent)' :
          variant === 'danger' ? 'rgba(255,77,109,0.3)' :
          variant === 'success' ? 'var(--accent-border)' :
          'var(--border)',
        padding: size === 'sm' ? '5px 10px' : size === 'lg' ? '9px 18px' : '7px 14px',
        fontSize: size === 'sm' ? '12px' : '13px',
        fontWeight: 500,
        borderRadius: 'var(--radius)',
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        opacity: props.disabled ? 0.4 : 1,
        transition: 'all 0.15s',
        fontFamily: 'var(--sans)',
      }}
      {...props}
    >
      {loading && <Loader size={12} style={{ animation: 'spin 1s linear infinite' }} />}
      {children}
    </button>
  );
}

// ── Badge ───────────────────────────────────────────────────────────────────
export function Badge({ children, variant = 'default' }) {
  const styles = {
    default: { background: 'var(--bg4)', color: 'var(--text2)', border: '1px solid var(--border)' },
    success: { background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid var(--accent-border)' },
    danger: { background: 'var(--red-dim)', color: 'var(--red)', border: '1px solid rgba(255,77,109,0.3)' },
    warning: { background: 'var(--yellow-dim)', color: 'var(--yellow)', border: '1px solid rgba(240,180,41,0.3)' },
    info: { background: 'var(--blue-dim)', color: 'var(--blue)', border: '1px solid rgba(59,158,255,0.3)' },
    purple: { background: 'rgba(167,139,250,0.12)', color: 'var(--purple)', border: '1px solid rgba(167,139,250,0.3)' },
  };

  return (
    <span style={{
      ...styles[variant] || styles.default,
      fontSize: '11px', fontWeight: 600,
      padding: '2px 8px', borderRadius: '100px',
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      fontFamily: 'var(--mono)', letterSpacing: '0.03em',
      textTransform: 'uppercase',
    }}>
      {children}
    </span>
  );
}

// ── StatusBadge ─────────────────────────────────────────────────────────────
export function StatusBadge({ status }) {
  // Status color mapping with specific colors:
  // - Running: Green (success)
  // - Stopped: Shiny grey (silver/metallic)
  // - Error: Bright Red (danger)
  // - Getting ready (building/starting): Orange (warning)
  const map = {
    running: { variant: 'success', dot: true, color: '#22c55e', glow: true },
    building: { variant: 'warning', dot: true, pulse: true, color: '#f97316' },
    stopped: { variant: 'default', dot: true, color: '#94a3b8', shiny: true },
    error: { variant: 'danger', dot: true, color: '#ef4444', bright: true },
    pending: { variant: 'info', dot: true, pulse: true, color: '#3b82f6' },
    success: { variant: 'success', color: '#22c55e' },
    failed: { variant: 'danger', color: '#ef4444', bright: true },
    starting: { variant: 'warning', dot: true, pulse: true, color: '#f97316' },
    restarting: { variant: 'warning', dot: true, pulse: true, color: '#f59e0b' },
  };
  const cfg = map[status] || map.stopped;

  // Custom styles based on status
  const getStatusStyle = () => {
    const base = {
      fontSize: '11px', fontWeight: 600,
      padding: '2px 8px', borderRadius: '100px',
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      fontFamily: 'var(--mono)', letterSpacing: '0.03em',
      textTransform: 'uppercase',
      border: '1px solid',
    };

    switch (status) {
      case 'running':
        return {
          ...base,
          background: 'rgba(34, 197, 94, 0.15)',
          color: '#22c55e',
          borderColor: 'rgba(34, 197, 94, 0.35)',
          boxShadow: '0 0 8px rgba(34, 197, 94, 0.25)',
        };
      case 'stopped':
        return {
          ...base,
          background: 'linear-gradient(145deg, rgba(148, 163, 184, 0.15), rgba(100, 116, 139, 0.1))',
          color: '#94a3b8',
          borderColor: 'rgba(148, 163, 184, 0.4)',
          textShadow: '0 0 2px rgba(148, 163, 184, 0.5)',
        };
      case 'error':
      case 'failed':
        return {
          ...base,
          background: 'rgba(239, 68, 68, 0.15)',
          color: '#ff5555',
          borderColor: 'rgba(239, 68, 68, 0.5)',
          boxShadow: '0 0 10px rgba(239, 68, 68, 0.3)',
          textShadow: '0 0 2px rgba(239, 68, 68, 0.5)',
        };
      case 'building':
      case 'starting':
        return {
          ...base,
          background: 'rgba(249, 115, 22, 0.15)',
          color: '#fb923c',
          borderColor: 'rgba(249, 115, 22, 0.4)',
        };
      case 'pending':
        return {
          ...base,
          background: 'rgba(59, 130, 246, 0.15)',
          color: '#60a5fa',
          borderColor: 'rgba(59, 130, 246, 0.35)',
        };
      default:
        return {
          ...base,
          background: 'var(--bg4)',
          color: 'var(--text2)',
          borderColor: 'var(--border)',
        };
    }
  };

  return (
    <span style={getStatusStyle()}>
      {cfg.dot && (
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: cfg.color || 'currentColor',
          display: 'inline-block',
          animation: cfg.pulse ? 'pulse 1.5s ease infinite' : 'none',
          boxShadow: cfg.glow ? `0 0 6px ${cfg.color}` : 'none',
        }} />
      )}
      {status}
    </span>
  );
}

// ── Card ────────────────────────────────────────────────────────────────────
export function Card({ children, className, style, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--bg2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '20px',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color 0.15s',
        ...style
      }}
      onMouseEnter={e => onClick && (e.currentTarget.style.borderColor = 'var(--border2)')}
      onMouseLeave={e => onClick && (e.currentTarget.style.borderColor = 'var(--border)')}
    >
      {children}
    </div>
  );
}

// ── Modal ───────────────────────────────────────────────────────────────────
export function Modal({ open, onClose, title, children, width = 560 }) {
  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, backdropFilter: 'blur(4px)', padding: '20px'
      }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border2)',
        borderRadius: 'var(--radius-lg)', width: '100%', maxWidth: width,
        maxHeight: '90vh', overflow: 'auto',
        animation: 'fadeIn 0.15s ease'
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '18px 24px', borderBottom: '1px solid var(--border)'
        }}>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)' }}>{title}</h2>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'var(--text3)',
            cursor: 'pointer', padding: '4px', borderRadius: '4px',
            display: 'flex', alignItems: 'center',
          }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--text)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
          ><X size={16} /></button>
        </div>
        <div style={{ padding: '24px' }}>{children}</div>
      </div>
    </div>
  );
}

// ── FormField ───────────────────────────────────────────────────────────────
export function FormField({ label, children, hint, error }) {
  return (
    <div style={{ marginBottom: '16px' }}>
      {label && <label>{label}</label>}
      {children}
      {hint && <p style={{ fontSize: '12px', color: 'var(--text3)', marginTop: '5px' }}>{hint}</p>}
      {error && <p style={{ fontSize: '12px', color: 'var(--red)', marginTop: '5px' }}>{error}</p>}
    </div>
  );
}

// ── LogViewer ───────────────────────────────────────────────────────────────
export function LogViewer({ lines = [], height = 400 }) {
  const ref = React.useRef(null);

  React.useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);

  return (
    <div
      ref={ref}
      style={{
        background: 'var(--bg)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', height,
        overflow: 'auto', padding: '12px 16px',
        fontFamily: 'var(--mono)', fontSize: '12px',
        lineHeight: '1.8', color: 'var(--text2)',
      }}
    >
      {lines.length === 0
        ? <span style={{ color: 'var(--text3)' }}>No output yet...</span>
        : lines.map((line, i) => (
          <div key={i} style={{
            color: line.includes('❌') || line.includes('Error') || line.includes('failed') ? 'var(--red)'
              : line.includes('✅') || line.includes('🎉') ? 'var(--accent)'
              : line.includes('⚠') ? 'var(--yellow)'
              : line.includes('🚀') || line.includes('📦') ? 'var(--blue)'
              : 'var(--text2)'
          }}>
            {line || '\u00A0'}
          </div>
        ))
      }
    </div>
  );
}

// ── Toast ───────────────────────────────────────────────────────────────────
export function ToastContainer({ toasts }) {
  return (
    <div style={{
      position: 'fixed', bottom: '24px', right: '24px',
      display: 'flex', flexDirection: 'column', gap: '8px', zIndex: 9999
    }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          background: 'var(--bg3)', border: `1px solid ${t.type === 'error' ? 'var(--red)' : 'var(--accent-border)'}`,
          color: t.type === 'error' ? 'var(--red)' : 'var(--text)',
          padding: '12px 16px', borderRadius: 'var(--radius)',
          fontSize: '13px', maxWidth: '320px',
          animation: 'slideIn 0.2s ease',
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)'
        }}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ── Spinner ─────────────────────────────────────────────────────────────────
export function Spinner({ size = 18 }) {
  return (
    <div style={{
      width: size, height: size,
      border: '2px solid var(--border)',
      borderTopColor: 'var(--accent)',
      borderRadius: '50%',
      animation: 'spin 0.8s linear infinite',
      display: 'inline-block', flexShrink: 0
    }} />
  );
}

// ── EmptyState ───────────────────────────────────────────────────────────────
export function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', padding: '60px 20px', textAlign: 'center'
    }}>
      {Icon && <Icon size={40} style={{ color: 'var(--text3)', marginBottom: '16px' }} />}
      <h3 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>{title}</h3>
      {description && <p style={{ color: 'var(--text2)', marginBottom: '24px', maxWidth: '360px', lineHeight: 1.6 }}>{description}</p>}
      {action}
    </div>
  );
}

// ── Terminal ────────────────────────────────────────────────────────────────
export function Terminal({ onData, onInput, connected, containerName }) {
  const termRef = React.useRef(null);
  const inputRef = React.useRef('');

  React.useEffect(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight;
    }
  }, [onData]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      const data = inputRef.current + '\r';
      onInput?.(btoa(data));
      inputRef.current = '';
    } else if (e.key === 'Backspace') {
      inputRef.current = inputRef.current.slice(0, -1);
      onInput?.(btoa('\b'));
    } else if (e.key.length === 1) {
      inputRef.current += e.key;
      onInput?.(btoa(e.key));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onInput?.(btoa('\t'));
    } else if (e.key === 'Escape') {
      onInput?.(btoa('\x1b'));
    }
  };

  // Decode base64 data for display
  const decodedData = React.useMemo(() => {
    if (!onData) return '';
    try {
      if (typeof onData === 'string') {
        return atob(onData);
      }
      return onData.map(d => {
        try { return atob(d); } catch { return d; }
      }).join('');
    } catch {
      return onData;
    }
  }, [onData]);

  return (
    <div style={{
      background: '#1a1a1a',
      borderRadius: 'var(--radius)',
      border: '1px solid var(--border)',
      overflow: 'hidden',
      fontFamily: 'var(--mono)',
    }}>
      {/* Terminal header */}
      <div style={{
        background: 'var(--bg3)',
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: connected ? 'var(--accent)' : 'var(--red)'
          }} />
          <span style={{ fontSize: '12px', color: 'var(--text2)' }}>
            {connected ? `Connected: ${containerName}` : 'Disconnected'}
          </span>
        </div>
        <span style={{ fontSize: '11px', color: 'var(--text3)' }}>
          bash/sh/zsh
        </span>
      </div>

      {/* Terminal output */}
      <div
        ref={termRef}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        style={{
          padding: '12px',
          minHeight: '300px',
          maxHeight: '400px',
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          fontSize: '13px',
          lineHeight: '1.4',
          color: '#e0e0e0',
          outline: 'none',
          cursor: 'text',
        }}
      >
        {decodedData}
      </div>

      {/* Input hint */}
      <div style={{
        padding: '6px 12px',
        background: 'var(--bg2)',
        borderTop: '1px solid var(--border)',
        fontSize: '11px',
        color: 'var(--text3)',
      }}>
        Click terminal and type. Press Enter to execute commands.
      </div>
    </div>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────
export function Tabs({ tabs, active, onChange }) {
  return (
    <div style={{
      display: 'flex', borderBottom: '1px solid var(--border)',
      gap: '0', marginBottom: '24px'
    }}>
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          style={{
            background: 'none', border: 'none',
            borderBottom: `2px solid ${active === tab.id ? 'var(--accent)' : 'transparent'}`,
            color: active === tab.id ? 'var(--accent)' : 'var(--text3)',
            padding: '10px 18px', fontSize: '13px', fontWeight: 500,
            cursor: 'pointer', transition: 'all 0.15s',
            display: 'flex', alignItems: 'center', gap: '6px',
            marginBottom: '-1px',
          }}
        >
          {tab.icon && <tab.icon size={14} />}
          {tab.label}
        </button>
      ))}
    </div>
  );
}
