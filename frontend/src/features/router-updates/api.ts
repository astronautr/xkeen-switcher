import { useMutation, useQuery } from "@tanstack/react-query";
import { useRuntimeRevision, useSessionRuntime } from "../../app/AppSessionProvider";
import { ApiError } from "../../api/client";
import { keys } from "../../api/keys";
import type { Automatic, Component, ReplacedSchedules, RestoreStep, Updates, Versions } from "./model";

type Start = { id: string; component: Component; version: string; cancel_schedule?: boolean };
export type UpdateAction =
  | { path: "check"; body: Record<string, never> }
  | { path: "auto"; method: "PUT"; body: Automatic }
  | { path: "schedule"; method: "PUT"; body: { component: Component; version: string; at: string } }
  | { path: "schedule"; method: "DELETE"; body: { component: Component } }
  | { path: "install"; body: Start }
  | { path: "batch"; body: { id: string; versions: Versions; at?: string; replace_schedules?: ReplacedSchedules } }
  | { path: "batch"; method: "PUT"; body: { id: string; at: string } }
  | { path: "batch"; method: "DELETE"; body: { id: string } }
  | { path: "recover"; body: { id: string } }
  | { path: "rollback"; body: Start & { plan: RestoreStep[]; revision: string } };

const path = "/api/router-updates";
const key = ["router-updates"] as const;

export function useRouterUpdates() {
  const runtime = useRuntimeRevision();
  return useQuery<Updates, ApiError>({
    queryKey: key, queryFn: ({ signal }) => runtime.readResponse<Updates>(path, signal),
    enabled: runtime.authenticated, refetchOnMount: "always",
    refetchInterval: query => query.state.data?.operation || query.state.data?.pair?.state === "running" ? 2000 : 15000,
  });
}

export function useUpdateAction() {
  const runtime = useSessionRuntime();
  return useMutation<Updates, ApiError, UpdateAction>({
    retry: false, networkMode: "always",
    mutationFn: async input => {
      const epoch = runtime.api.epoch;
      const response = await runtime.mutate<Updates>(
        path + "/" + input.path, input.body, "method" in input ? input.method : "POST", [keys.status],
      );
      runtime.api.assertCurrent(epoch);
      // An earlier background GET must not replace the newly accepted operation.
      await runtime.queryClient.cancelQueries({ queryKey: key, exact: true });
      runtime.api.assertCurrent(epoch);
      runtime.queryClient.setQueryData(key, response);
      return response;
    },
  });
}
