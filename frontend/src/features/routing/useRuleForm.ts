import { useEffect, useState } from "react";
import type { RoutingScratch } from "../../browser/storage";
import { StaleSessionError } from "../../api/client";
import { isRecord, type MatcherDto, type RoutingGroup, type RoutingDto } from "../../api/types";
import { useRoutingEditorAccess } from "../../api/queries";
import { baseOf, createForm, fields, same, type Form } from "./model";

function matcher(value: unknown): value is MatcherDto {
  return isRecord(value) && typeof value.type === "string" && typeof value.value === "string";
}

function storedGroup(value: unknown): RoutingGroup | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.action !== "string" ||
    typeof value.editable !== "boolean" ||
    typeof value.default_rule !== "boolean" ||
    !isRecord(value.rule) ||
    !Array.isArray(value.matchers) ||
    !value.matchers.every(matcher)
  )
    return null;
  // Older new-rule scratch did not include catch_all.
  return { ...value, catch_all: value.catch_all === true } as RoutingGroup;
}

function recover(scratch: RoutingScratch): Form | null {
  const { form, base, revision } = scratch;
  const rule = storedGroup(form.rule);
  const original = storedGroup(form.original);
  if (
    !rule ||
    !original ||
    rule.id !== original.id ||
    !form.entries.every(matcher) ||
    !isRecord(form.initial) ||
    typeof form.initial.title !== "string" ||
    typeof form.initial.action !== "string" ||
    !Array.isArray(form.initial.entries) ||
    !form.initial.entries.every(matcher)
  )
    return null;
  const removed = form.removed;
  return {
    rule,
    original,
    base,
    revision,
    isNew: form.isNew === true,
    detailsOpen: form.detailsOpen === true,
    entries: form.entries,
    initial: { title: form.initial.title, action: form.initial.action, entries: form.initial.entries },
    removed:
      isRecord(removed) && matcher(removed.entry) && typeof removed.index === "number"
        ? { entry: removed.entry, index: removed.index }
        : null,
  };
}

export function useRuleForm(
  hash: string,
  info: RoutingDto | undefined,
  returned: string | null,
  setFailure: (error: unknown) => void,
) {
  const [, view, id] = hash.split("/");
  const access = useRoutingEditorAccess();
  const [form, setForm] = useState<Form | null>(null);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!info || view !== "group") return;
    const controller = new AbortController();
    async function initialize() {
      const scratch = access.readScratch();
      if (scratch && (id === "new" ? scratch.form.isNew : scratch.form.rule.id === id)) {
        const saved = recover(scratch);
        if (saved) {
          setForm(saved);
          setRestored(true);
          return;
        }
      }
      let rule = (info!.draft?.model ?? info!.model)?.groups.find((item) => item.id === id);
      if (id === "new") {
        const result = await access.newRuleId(controller.signal);
        rule = {
          id: result.id,
          title: "",
          action: "direct",
          rule: {},
          matchers: [],
          editable: true,
          default_rule: false,
          catch_all: false,
        };
      }
      if (!rule) throw new Error("Rule not found. Return to the routing list.");
      if (!controller.signal.aborted) {
        const next = createForm(rule, id === "new", baseOf(info!));
        if (rule.id === returned) next.detailsOpen = true;
        setForm(next);
      }
    }
    void initialize().catch((e) => {
      if (!controller.signal.aborted && !(e instanceof StaleSessionError)) setFailure(e);
    });
    return () => controller.abort();
    // A form freezes its base. Subsequent reads only update its conflict indicator.
  }, [hash, !!info, access]);
  useEffect(() => {
    if (view === "group") return;
    setForm(null);
    setRestored(false);
  }, [hash]);
  function update(form: Form) {
    setForm(form);
    access.saveScratch(
      same(fields(form), form.initial)
        ? null
        : { version: 1, base: form.base, revision: form.revision, form },
    );
  }

  function resetForm() {
    if (form) access.saveScratch(null);
    setForm(null);
    setRestored(false);
  }
  return { form, restored, update, resetForm };
}
