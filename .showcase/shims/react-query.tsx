// The screen reads its data through react-query; the showcase has one static snapshot, so every
// query resolves immediately from the mocks installed on the window.
import { createElement } from "react";

export function useQuery(options: { queryKey?: unknown[]; queryFn?: () => unknown }) {
  const key = String(options?.queryKey?.[1] ?? "");
  if (key === "snapshot") return { data: (globalThis as any).__MOCK_SNAPSHOT__, isPending: false, isError: false, error: null, refetch: async () => {} };
  const data = (globalThis as any).__MOCK_QUERY__?.[key];
  return { data, isPending: false, isError: false, error: null, refetch: async () => {} };
}

export function useQueryClient() {
  return { invalidateQueries: async () => {} };
}

export { createElement };
