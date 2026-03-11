import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useStore } from './lib/store.js';
import Sidebar from './components/Sidebar.jsx';
import Dashboard from './pages/Dashboard.jsx';
import AppsPage from './pages/Apps.jsx';
import AppDetail from './pages/AppDetail.jsx';
import TemplatesPage from './pages/Templates.jsx';
import { StacksPage, ContainersPage, DeploymentsPage, SettingsPage, LoginPage } from './pages/OtherPages.jsx';
import { ToastContainer } from './components/ui.jsx';

function Layout({ children }) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar />
      <main style={{ flex: 1, overflowY: 'auto', minWidth: 0 }}>
        {children}
      </main>
    </div>
  );
}

function RequireAuth({ children }) {
  const token = useStore(s => s.token);
  const fetchUser = useStore(s => s.fetchUser);
  const user = useStore(s => s.user);
  React.useEffect(() => { if (token && !user) fetchUser(); }, [token]);
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const toasts = useStore(s => s.toasts);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/*" element={
          <RequireAuth>
            <Layout>
              <Routes>
                <Route path="/"           element={<Dashboard />} />
                <Route path="/apps"       element={<AppsPage />} />
                <Route path="/apps/:id"   element={<AppDetail />} />
                <Route path="/stacks"     element={<StacksPage />} />
                <Route path="/templates"  element={<TemplatesPage />} />
                <Route path="/containers" element={<ContainersPage />} />
                <Route path="/deployments" element={<DeploymentsPage />} />
                <Route path="/settings"   element={<SettingsPage />} />
              </Routes>
            </Layout>
          </RequireAuth>
        } />
      </Routes>
      <ToastContainer toasts={toasts} />
    </BrowserRouter>
  );
}
