import { expect, it } from "@rstest/core";
import type { EventDto, OperationDto } from "../api/types";
import { activityPresentation, eventNeedsAttention, sourceLabel } from "./policy";

const ownId = "974b51cf-7059-4f51-a186-997d69c84eea";
const startedAt = "2026-11-17T12:00:00Z";

function operation(values: Partial<OperationDto>): OperationDto {
  return { id: null, phase: "preparing", ...values };
}

function event(action: string, result = "ok", more?: Partial<EventDto>): EventDto {
  return { ts: startedAt, action, result, ...more };
}

it("finished operations immediately return the activity launcher to idle", () => {
  const finished = ["committed", "rolled_back", "rejected"].map((phase) =>
    operation({ id: ownId, kind: "main", local: true, phase }),
  );
  for (const op of [null, undefined, ...finished]) {
    expect(activityPresentation(op, [ownId])).toEqual({
      key: null,
      active: false,
      attention: false,
      delay: 0,
      label: "No active operations",
      description: "No router operation is in progress.",
    });
  }
});

it("unconfirmed operations stay active and bypass the own-action delay", () => {
  for (const phase of ["unknown", "recovery_failed"]) {
    const result = activityPresentation(
      operation({ id: ownId, kind: "main", local: true, phase }),
      [ownId],
    );
    expect(result).toMatchObject({ active: true, attention: true, delay: 0 });
    expect(result.description).toMatch(/confirmed|attention/);
    expect(result.description).toContain("paused");
  }
});

it("own requests have one longer delay regardless of which identity is available", () => {
  for (const identity of [{ id: ownId }, { request_id: ownId }, { local: true }]) {
    for (const kind of ["main", "update", "route_check"]) {
      expect(activityPresentation(operation({ ...identity, kind }), [ownId])).toMatchObject({
        active: true,
        attention: false,
        delay: 3000,
      });
    }
  }
});

it("routine background work is delayed while background mutations are immediate", () => {
  for (const kind of ["read", "sync", "probe", "route_check", "failover_check", "update"]) {
    expect(activityPresentation(operation({ kind, source: "scheduler" })).delay).toBe(1000);
  }
  for (const kind of [
    "main",
    "switch",
    "apply_failover",
    "routing",
    "device-location",
    "set_subscription_url",
    "xkeen_control",
  ]) {
    expect(activityPresentation(operation({ kind, source: "manual" })).delay).toBe(0);
  }
});

it("activity identity survives phase and message changes without merging distinct work", () => {
  const ephemeral = operation({ kind: "read", source: "startup", created_at: startedAt });
  for (const identity of [{ id: ownId }, { request_id: ownId }, ephemeral]) {
    const preparing = activityPresentation(operation({ ...identity, message: "Reading" }));
    const confirming = activityPresentation(
      operation({ ...identity, phase: "confirming", message: "Confirming", updated_at: "later" }),
    );
    expect(preparing.key).toBeTruthy();
    expect(confirming.key).toBe(preparing.key);
    expect(confirming.description).not.toBe(preparing.description);
  }
  const first = activityPresentation(ephemeral).key;
  for (const changed of [
    { kind: "update" },
    { source: "scheduler" },
    { created_at: "2026-11-17T12:01:00Z" },
  ]) {
    expect(activityPresentation({ ...ephemeral, ...changed }).key).not.toBe(first);
  }
  expect(activityPresentation(operation({ id: "one" })).key).not.toBe(
    activityPresentation(operation({ id: "two" })).key,
  );
});

it("activity descriptions explain the stage and actual blocking scope without raw transport details", () => {
  const op = operation({
    kind: "read",
    scope: "read",
    blocking: true,
    message: "ssh private-host failed at https://example.invalid/private-token",
  });
  const view = activityPresentation(op);
  expect(view.label).toBe("Reading from the router");
  expect(view.description).toContain("Preparing");
  expect(view.description).toContain("read finishes");
  expect(view.description).not.toMatch(/ssh|private-host|private-token/);
  expect(activityPresentation({ ...op, blocking: false }).description).not.toMatch(/wait|paused/);
  expect(
    activityPresentation(operation({ kind: "route_check", scope: "diagnostic" })).description,
  ).toContain("wait for this check");
});

it("source labels require evidence before attributing work to a browser", () => {
  for (const props of [
    {},
    { source: "manual" },
    { trigger: "manual" },
    { source: "unrecognized" },
    { id: "foreign" },
  ]) {
    expect(sourceLabel(operation(props), [ownId])).toBe("Router");
  }
  for (const identity of [{ id: ownId }, { request_id: ownId }, { local: true }]) {
    expect(sourceLabel(operation({ source: "manual", ...identity }), [ownId])).toBe("This browser");
  }
  for (const [props, label] of [
    [{ source: "failover" }, "Failover"],
    [{ trigger: "failover" }, "Failover"],
    [{ source: "scheduler" }, "Scheduled update"],
    [{ trigger: "auto-reapply" }, "Scheduled update"],
    [{ trigger: "cron" }, "Scheduled update"],
    [{ source: "startup" }, "Server startup"],
  ] as const) {
    expect(sourceLabel(operation(props))).toBe(label);
  }
});

it("meaningful server failures request attention while routine checks remain silent", () => {
  for (const action of [
    "update",
    "switch",
    "active-refresh",
    "xkeen",
    "routing-apply",
    "routing-restore",
    "routing-device-location",
    "device-change",
    "failover-switch",
    "auto-recovery",
  ]) {
    expect(eventNeedsAttention(event(action, "fail"))).toBe(true);
    expect(eventNeedsAttention(event(action))).toBe(false);
  }
  for (const action of [
    "read",
    "sync",
    "probe",
    "route_check",
    "failover_check",
    "route-check",
    "failover-check",
  ]) {
    for (const result of ["ok", "fail"])
      expect(eventNeedsAttention(event(action, result))).toBe(false);
  }
  for (const entry of [
    null,
    {},
    event("update", "ok", { message: "no changes" }),
    event("update", "ok", { message: "active config update pending" }),
  ]) {
    expect(eventNeedsAttention(entry)).toBe(false);
  }
});

it("total failure stops and lost active routes need attention even when recorded successfully", () => {
  for (const result of ["ok", "fail"])
    expect(eventNeedsAttention(event("total-failure-stop", result))).toBe(true);
  for (const action of ["route-lost", "route-loss"])
    expect(eventNeedsAttention(event(action))).toBe(true);
  for (const message of [
    "active 'tr' vanished from subscription",
    "active chain location vanished from subscription",
  ]) {
    expect(eventNeedsAttention(event("update", "ok", { message }))).toBe(true);
  }
  for (const routing_phase of ["unknown", "recovery_failed", "rolled_back", "rejected"]) {
    expect(eventNeedsAttention(event("routing-apply", "ok", { routing_phase }))).toBe(true);
  }
});
