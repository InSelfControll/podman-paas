import { create } from 'zustand';
import { api } from '../lib/api.js';

export const useStore = create((set, get) => ({
  // Auth
  token: localStorage.getItem('paas_token'),
  user: null,
  setToken: (token) => {
    localStorage.setItem('paas_token', token);
    set({ token });
    // Fetch user info after setting token
    api.me().then(user => set({ user })).catch(() => {});
  },
  fetchUser: async () => {
    try {
      const user = await api.me();
      set({ user });
    } catch {
      // Token may be invalid
    }
  },
  logout: () => {
    localStorage.removeItem('paas_token');
    set({ token: null, user: null });
  },

  // Apps
  apps: [],
  appsLoading: false,
  fetchApps: async () => {
    set({ appsLoading: true });
    try {
      const apps = await api.getApps();
      set({ apps: apps || [] });
    } catch {}
    set({ appsLoading: false });
  },

  // Overview
  overview: null,
  fetchOverview: async () => {
    try {
      const overview = await api.getOverview();
      set({ overview });
    } catch {}
  },

  // Stacks
  stacks: [],
  fetchStacks: async () => {
    try {
      const stacks = await api.getStacks();
      set({ stacks: stacks || [] });
    } catch {}
  },

  // Toast notifications
  toasts: [],
  addToast: (toast) => {
    const id = Date.now();
    set(s => ({ toasts: [...s.toasts, { ...toast, id }] }));
    setTimeout(() => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), 4000);
  },
}));
