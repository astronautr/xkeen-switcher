import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { ChoicePopup } from "../../ui/ChoicePopup";
import { Field, Textarea } from "../../ui/Field";
import { Notice } from "../../ui/feedback";
import { Panel, Action, PendingAction } from "./parts";
import { actions, fields, same, types, typeInfo, type Form } from "./model";

type Props = Omit<ComponentProps<typeof Panel>, "children" | "footer" | "title" | "embedded"> & {
  form: Form;
  onChange: (form: Form) => void;
  locked: boolean;
  busy: boolean;
  saving: boolean;
  /** Text of the frozen action when it is not this editor's save. */
  activity: string | null;
  anchored: boolean;
  onSave: () => void;
  onDelete: () => void;
};
export function RuleEditor({ form, onChange, locked, busy, saving, activity, anchored, onSave, onDelete, ...panel }: Props) {
  useEffect(() => {
    const viewport = window.visualViewport;
    function resize() {
      const scaled = viewport?.scale === 1;
      const inset = scaled ? Math.max(0, innerHeight - viewport.height - viewport.offsetTop) : 0;
      document.documentElement.style.setProperty("--routing-keyboard-inset", inset + "px");
      document.documentElement.style.setProperty(
        "--routing-viewport-top",
        (scaled ? viewport.offsetTop : 0) + "px",
      );
    }
    resize();
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      document.documentElement.style.removeProperty("--routing-keyboard-inset");
      document.documentElement.style.removeProperty("--routing-viewport-top");
    };
  }, []);
  const { rule, entries } = form;
  const readonly = locked || busy || !rule.editable;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const pendingFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const mobile = matchMedia("(max-width:720px)").matches;
    const target = mobile
      ? document.getElementById("routing-panel-title")
      : form.isNew
        ? document.getElementById("rule-name")
        : document.querySelector<HTMLElement>(".selected-rule .rule-row");
    if (mobile) window.scrollTo(0, 0);
    target?.focus({ preventScroll: mobile });
    const editor = document.querySelector<HTMLElement>('[data-marker="routing-rule-editor"]');
    if (!editor || !editor.animate || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const revealOnly = mobile || form.isNew;
    const height = editor.getBoundingClientRect().height;
    const marginBottom = getComputedStyle(editor).marginBottom;
    if (!revealOnly) editor.classList.add("rule-opening");
    const frames = revealOnly ? [{ opacity: 0 }, { opacity: 1 }] : [
      { height: "0px", marginBottom: "0px", opacity: 0 },
      { height: height + "px", marginBottom, opacity: 1 },
    ];
    const animation = editor.animate(frames, { duration: 240, easing: "cubic-bezier(0.22, 0.9, 0.3, 1)" });
    animation.onfinish = () => editor.classList.remove("rule-opening");
    return () => {
      animation.cancel();
      editor.classList.remove("rule-opening");
    };
  }, []);
  useLayoutEffect(() => {
    if (pendingFocus.current) {
      document.querySelector<HTMLElement>(pendingFocus.current)?.focus();
      pendingFocus.current = null;
    }
  });
  function update(next: Partial<Form>) {
    setErrors({});
    onChange({ ...form, ...next });
  }
  function save() {
    const invalid: Record<string, string> = {};
    if (!rule.title.trim()) invalid["rule-name"] = "Enter a name for this rule.";
    entries.forEach(({ type, value }, i) => {
      if (!value.trim()) invalid["condition-" + i] = "Enter a value or remove this condition.";
      else if (
        ["domain-suffix", "domain-exact"].includes(type) &&
        value.split("\n").some((line) => /[\s/:*]/.test(line.trim()))
      )
        invalid["condition-" + i] = "Enter hostnames only, without https:// or a path. One per line.";
    });
    const first = Object.keys(invalid)[0];
    if (!first) {
      onSave();
      return;
    }
    if (first === "rule-name") onChange({ ...form, detailsOpen: true });
    pendingFocus.current = "#" + first;
    setErrors(invalid);
  }
  const details = (
    <details
      className={"rule-details" + (form.isNew ? " new-rule-details" : "")}
      open={form.detailsOpen}
      onToggle={(event) => {
        const open = event.currentTarget.open;
        if (open !== form.detailsOpen) onChange({ ...form, detailsOpen: open });
      }}
    >
      <summary data-marker="rule-details">rule details</summary>
      <div className="panel-field rule-name-field">
        <label htmlFor="rule-name">name</label>
        <Field
          id="rule-name"
          marker="rule-name"
          value={rule.title}
          maxLength={120}
          autoComplete="off"
          disabled={readonly}
          aria-invalid={!!errors["rule-name"] || undefined}
          onChange={(e) => update({ rule: { ...rule, title: e.target.value } })}
        />
        {errors["rule-name"] && (
          <p className="field-error" role="alert">
            {errors["rule-name"]}
          </p>
        )}
      </div>
      {rule.default_rule && (
        <p className="field-hint">
          Default rule · its conditions, action and position can change. It cannot be deleted.
        </p>
      )}
      {!form.isNew && !rule.default_rule && !readonly && (
        <div className="delete-row">
          <Action marker="rule-delete" onClick={onDelete} disabled={anchored}>
            delete rule
          </Action>
          {anchored && (
            <p className="field-hint">
              Deleting this rule would shift a custom rule. Custom positions are preserved.
            </p>
          )}
        </div>
      )}
    </details>
  );
  const dirty = !same(fields(form), form.initial);
  const footer = (
    <>
      <span className="footer-copy" data-marker="rule-save-status" role="status">
        {busy
          ? saving ? "" : activity ?? "Waiting for the current routing action"
          : locked
            ? "Save paused · edits kept"
            : dirty
              ? "Unsaved edits · router unchanged"
              : "No unsaved edits"}
      </span>
      <div className="editor-footer-actions">
        <Action marker="rule-cancel" onClick={panel.close}>
          cancel
        </Action>
        <PendingAction marker="routing-save-draft" primary disabled={readonly || !dirty} onClick={save}
          idle="save to draft" pending="saving" busy={saving} />
      </div>
    </>
  );
  return (
    <Panel {...panel} title={rule.title || "new rule"} embedded footer={footer}>
      {readonly && !busy && (
        <Notice
          title={rule.editable ? "Editing is paused" : "Custom rule · read only"}
          detail={
            rule.editable
              ? "Resolve the configuration conflict before saving."
              : "The original fields and position are preserved."
          }
        />
      )}
      {(form.isNew || !rule.editable) && details}
      {!rule.editable ? (
        <pre className="raw-preview">{JSON.stringify(rule.rule, null, 2)}</pre>
      ) : (
        <>
          <section className="panel-section rule-action-section">
            <h3>route matching traffic</h3>
            <div className="t-seg" role="group" aria-label="Route action">
              {["direct", "proxy", "block"].map((key) => (
                <button
                  key={key}
                  className="t-seg-btn"
                  type="button"
                  disabled={readonly}
                  data-marker={"action-" + key}
                  aria-pressed={rule.action === key}
                  onClick={() => update({ rule: { ...rule, action: key } })}
                >
                  {actions[key]}
                </button>
              ))}
            </div>
            <p className="field-hint">Via proxy follows the active location on the home screen.</p>
          </section>
          <section className="panel-section rule-match-section">
            <h3>when traffic matches</h3>
            {!entries.length && (
              <Notice
                title="All remaining traffic at this position"
                detail="No conditions: matches all redirect/tproxy traffic reaching this rule."
              />
            )}
            {[...new Set(entries.map((entry) => typeInfo(entry.type)[2]))].map((field, fieldIndex) => (
              <Fragment key={field}>
                {fieldIndex > 0 && <div className="and-divider">AND · must also match</div>}
                <div className="match-group">
                  <h3>
                    {field}
                    <span>match any value</span>
                  </h3>
                  {entries.map((entry, index) => {
                    const [, label, group, placeholder, hint] = typeInfo(entry.type);
                    if (group !== field) return null;
                    const id = "condition-" + index;
                    const control = {
                      id,
                      disabled: readonly,
                      value: entry.value,
                      "aria-describedby": id + "-hint",
                      "aria-invalid": !!errors[id] || undefined,
                    };
                    const changeValue = (value: string) =>
                      update({
                        entries: entries.map((item, i) => (i === index ? { ...entry, value } : item)),
                      });
                    return (
                      <div className="condition-entry" key={entry.type}>
                        <div className="condition-head">
                          <label className="condition-label" htmlFor={id}>
                            {label}
                          </label>
                          {!readonly && (
                            <Action
                              marker={"remove-" + id}
                              onClick={() => {
                                pendingFocus.current = '[data-marker="undo-condition"]';
                                update({
                                  removed: { entry, index },
                                  entries: entries.filter((_, i) => i !== index),
                                });
                              }}
                            >
                              remove
                            </Action>
                          )}
                        </div>
                        {entry.type === "network" ? (
                          <select
                            {...control}
                            data-marker={id}
                            className="condition-trigger network-select"
                            onChange={(e) => changeValue(e.target.value)}
                          >
                            <option value="tcp">TCP</option>
                            <option value="udp">UDP</option>
                            <option value="tcp,udp">TCP or UDP</option>
                          </select>
                        ) : (
                          <Textarea
                            {...control}
                            marker={id}
                            rows={Math.min(8, Math.max(2, entry.value.split("\n").length + 1))}
                            placeholder={placeholder}
                            spellCheck={false}
                            autoCapitalize="off"
                            autoComplete="off"
                            autoCorrect="off"
                            inputMode={
                              ["domain-suffix", "domain-exact", "ip", "source"].includes(entry.type)
                                ? "url"
                                : "text"
                            }
                            onChange={(e) => changeValue(e.target.value)}
                          />
                        )}
                        {errors[id] && (
                          <p role="alert" className="field-error">
                            {errors[id]}
                          </p>
                        )}
                        <p className="field-hint" id={id + "-hint"}>
                          {hint}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </Fragment>
            ))}
            {form.removed && !readonly && (
              <Notice
                title={typeInfo(form.removed.entry.type)[1] + " removed"}
                actions={
                  <Action
                    marker="undo-condition"
                    onClick={() => {
                      const { index, entry } = form.removed!;
                      const next = entries.slice();
                      next.splice(index, 0, entry);
                      pendingFocus.current = "#condition-" + index;
                      update({ entries: next, removed: null });
                    }}
                  >
                    undo
                  </Action>
                }
              />
            )}
            {!readonly && (
              <ChoicePopup
                kind="menu"
                marker="add-condition"
                label="+ add condition"
                variant="bracket"
                className="condition-dropdown"
                triggerClass="condition-trigger t-btn"
                popupClass="condition-menu"
                optionClass="condition-option"
                minWidth={272}
                options={types.map(([value, label], i) => ({
                  value,
                  label,
                  separated: i === 8,
                  suffix: entries.some((e) => e.type === value) ? "added" : "",
                }))}
                onSelect={(type) => {
                  const index = entries.findIndex((entry) => entry.type === type);
                  if (index >= 0) {
                    document.getElementById("condition-" + index)?.focus();
                    return;
                  }
                  pendingFocus.current = "#condition-" + entries.length;
                  update({
                    entries: [...entries, { type, value: type === "network" ? "tcp,udp" : "" }],
                    removed: null,
                  });
                }}
              />
            )}
            <p className="effect-summary">
              Then → {actions[rule.action]}
              {rule.action === "proxy" ? " · active location" : ""}
            </p>
          </section>
          {!form.isNew && details}
        </>
      )}
    </Panel>
  );
}
