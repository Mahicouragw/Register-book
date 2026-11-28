// Stand-in for npm:@supabase/supabase-js@2 during tests.
//
// The point is NOT to fake Supabase, it is to prove createClient is actually
// reachable from inside the inflated bundle. If it is not imported there, the
// call throws before this file is ever touched — which is the whole regression.
//
// It records every call on globalThis so the test can assert the function
// body really got that far.

globalThis.__createClientCalls = (globalThis.__createClientCalls || 0) + 1;

export function createClient(url, key, opts) {
  globalThis.__createClientCalls = (globalThis.__createClientCalls || 0) + 1;
  return {
    url,
    key,
    opts,
    auth: {
      // rb-notify authenticates the caller with bearer tokens.
      async getUser() {
        return { data: { user: null }, error: { message: "no session" } };
      }
    },
    from() {
      return {
        select() { return this; },
        insert() { return this; },
        async eq() { return { data: [], error: null }; },
        async single() { return { data: null, error: null }; }
      };
    }
  };
}

export default { createClient };
