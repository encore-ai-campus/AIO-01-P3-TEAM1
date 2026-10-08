import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiState, fetchMe, login as apiLogin, logout as apiLogout, subscribeApiState, type Me } from "./api";

interface AuthValue {
  /** undefined = 확인 중, null = 로그인 안 됨 */
  me: Me | null | undefined;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((m) => {
        if (!cancelled) setMe(m);
      })
      .catch(() => {
        if (!cancelled) setMe(null);
      });
    // 어느 요청이든 401이면 로그인 화면으로 (RequireAuth가 원래 경로를 기억해 보낸다)
    const unsubscribe = subscribeApiState(() => {
      if (apiState.authLost()) setMe(null);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const m = await apiLogin(username, password);
    apiState.clearAuthLost();
    setMe(m);
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      setMe(null);
    }
  }, []);

  const value = useMemo(() => ({ me, login, logout }), [me, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("AuthProvider 안에서만 쓸 수 있습니다");
  return v;
}
