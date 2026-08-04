import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { storage } from "@/src/utils/storage";
import { apiFetch, TOKEN_KEY } from "@/src/api";

export type User = {
  id: string;
  email: string;
  role: "dealer" | "admin";
  active?: boolean;
  is_pricing_agent?: boolean;
  agreement_accepted_at?: string | null;
  dealer_info?: { first_name: string; last_name: string; phone: string; job_title?: string | null };
  company_info?: { company_name: string; company_address: string };
  profile_pic?: string | null;
  cover_photo?: string | null;
  dealership_id?: string | null;
  dealership?: { id: string; name: string; address?: string; active?: boolean } | null;
};

type AuthContextType = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (payload: any) => Promise<void>;
  logout: () => Promise<void>;
  markAgreementAccepted: (at: string) => void;
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const registerForPush = useCallback(async () => {
    if (Platform.OS === "web") return;
    try {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== "granted") return;
      const tokenResp = await Notifications.getDevicePushTokenAsync();
      await apiFetch("/api/register-push", {
        method: "POST",
        body: JSON.stringify({ platform: Platform.OS, device_token: tokenResp.data }),
      });
    } catch (e) {
      console.log("Push registration skipped:", e);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    const token = await storage.secureGet<string>(TOKEN_KEY, "");
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const data = await apiFetch("/api/auth/me");
      setUser(data.user);
      registerForPush();
    } catch {
      await storage.secureRemove(TOKEN_KEY);
    } finally {
      setLoading(false);
    }
  }, [registerForPush]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const login = async (email: string, password: string) => {
    const data = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    await storage.secureSet(TOKEN_KEY, data.token);
    setUser(data.user);
    registerForPush();
  };

  const register = async (payload: any) => {
    const data = await apiFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await storage.secureSet(TOKEN_KEY, data.token);
    setUser(data.user);
    registerForPush();
  };

  const logout = async () => {
    await storage.secureRemove(TOKEN_KEY);
    setUser(null);
  };

  const markAgreementAccepted = (at: string) => {
    setUser((prev) => (prev ? { ...prev, agreement_accepted_at: at } : prev));
  };

  const refreshUser = useCallback(async () => {
    try {
      const data = await apiFetch("/api/auth/me");
      setUser(data.user);
    } catch {
      /* silent — the caller can decide how to handle */
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, markAgreementAccepted, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
