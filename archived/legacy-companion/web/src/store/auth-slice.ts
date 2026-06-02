import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";

const AUTH_STORAGE_KEY = "companion_auth_token";

function getInitialAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(AUTH_STORAGE_KEY) || null;
}

export interface AuthSlice {
  authToken: string | null;
  isAuthenticated: boolean;

  setAuthToken: (token: string) => void;
  logout: () => void;
}

export const createAuthSlice: StateCreator<AppState, [], [], AuthSlice> = (set) => ({
  authToken: getInitialAuthToken(),
  isAuthenticated: getInitialAuthToken() !== null,

  setAuthToken: (token) => {
    localStorage.setItem(AUTH_STORAGE_KEY, token);
    set({ authToken: token, isAuthenticated: true });
  },
  logout: () => {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    set({ authToken: null, isAuthenticated: false });
  },
});
