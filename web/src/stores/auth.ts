import { defineStore } from "pinia";

const TOKEN_KEY = "synthia.token";

export function readToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

/**
 * 登录态：Token 存 sessionStorage（会话级，关闭标签即失效）。
 * 登录页验证 GET /projects 成功后写入。
 */
export const useAuthStore = defineStore("auth", {
  state: () => ({
    token: readToken(),
  }),
  getters: {
    isAuthenticated: (state) => state.token !== null && state.token.length > 0,
  },
  actions: {
    login(token: string) {
      sessionStorage.setItem(TOKEN_KEY, token);
      this.token = token;
    },
    logout() {
      clearToken();
      this.token = null;
    },
  },
});
