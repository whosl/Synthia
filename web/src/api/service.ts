import { createClient } from "./client.ts";
import { readToken, clearToken } from "../stores/auth.ts";
import { router } from "../router.ts";

// Resolve fetch at request time so development mock installation can happen at bootstrap.
export const api = createClient({
  fetchImpl: (...args) => fetch(...args),
  tokenProvider: readToken,
  onUnauthorized: () => {
    clearToken();
    const route = router.currentRoute.value;
    if (route.name !== "login") {
      void router.replace({
        name: "login",
        query: { expired: "1", redirect: route.fullPath },
      });
    }
  },
});
