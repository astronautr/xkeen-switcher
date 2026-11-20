import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { RoutingGroup, ValidationDto } from "../../api/types";
import { Field } from "../../ui/Field";
import { Action } from "./parts";
import { actions, summary } from "./model";

export function Rules({
  groups,
  changes,
  validation,
  ordering,
  editedId,
  editor,
  disabled,
  open,
  close,
  reorder,
  move,
  save,
  cancel,
  dirty,
  returned,
  onSearchChange,
}: {
  groups: RoutingGroup[];
  changes: Map<string, string>;
  validation: ValidationDto[];
  ordering: boolean;
  editedId?: string;
  editor: ReactNode;
  disabled: boolean;
  open: (id: string) => void;
  close: () => void;
  reorder: () => void;
  move: (from: number, to: number) => void;
  save: () => void;
  cancel: () => void;
  dirty: boolean;
  returned: string | null;
  onSearchChange: () => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const focus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (focus.current) {
      const el = focus.current;
      (el.matches(":disabled") ? el.parentElement?.querySelector<HTMLElement>("button:enabled") : el)?.focus({
        preventScroll: true,
      });
      focus.current = null;
    }
  });
  const visible = groups
    .map((rule, index) => ({
      rule,
      index,
      matches:
        ordering ||
        [rule.title, actions[rule.action], ...rule.matchers.map((m) => m.value)]
          .join(" ")
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    }))
    .filter(({ rule, matches }) => matches || rule.id === editedId || rule.id === returned);
  return (
    <div className="rule-workspace">
      <section className="box rule-box" aria-label="Routing rules">
        <div className="box-title">rules · {groups.length}</div>
        <div className="list-toolbar">
          <p>{ordering ? "Use ↑ ↓ to reorder. First match wins." : "First match wins, top to bottom."}</p>
          {!ordering && (
            <div className="inline-actions">
              <Action
                marker="routing-reorder"
                disabled={disabled}
                onClick={() => {
                  setQuery("");
                  reorder();
                }}
              >
                reorder
              </Action>
              <Action marker="routing-add" disabled={disabled} onClick={() => open("new")}>
                + add rule
              </Action>
            </div>
          )}
        </div>
        {!ordering && (
          <Field
            className="rule-search"
            type="search"
            marker="routing-search"
            value={query}
            placeholder="Find a rule, domain or IP…"
            aria-label="Find a rule, domain or IP"
            onChange={(e) => {
              setQuery(e.target.value);
              onSearchChange();
            }}
          />
        )}
        <ol className="rule-list">
          {visible.map(({ rule, index, matches }) => {
            const change = changes.get(rule.id);
            const selected = rule.id === editedId;
            const row = (
              <>
                <span className="rule-number">{String(index + 1).padStart(2, "0")}</span>
                <span className="rule-copy">
                  <span className="rule-name">
                    {rule.title}
                    {rule.default_rule && <span className="rule-badge">default</span>}
                    {!rule.editable && <span className="rule-badge">read only</span>}
                    {change && !ordering && <span className="change-label">{change}</span>}
                  </span>
                  <span className="rule-description">{summary(rule)}</span>
                </span>
                <span className={"rule-action action-" + rule.action}>
                  {actions[rule.action] ?? rule.action}
                </span>
              </>
            );
            const errors = validation.filter((v) => v.group_id === rule.id && v.severity === "error");
            return (
              <li
                key={rule.id}
                className={"rule-item" + (change ? " changed" : "") + (selected ? " selected-rule" : "")}
                data-rule-id={rule.id}
                data-marker="routing-group"
              >
                {ordering ? (
                  <div className="order-row">
                    <div className="rule-row">{row}</div>
                    <div className="wl-arrows order-controls">
                      {[-1, 1].map((delta) => {
                        const direction = delta === 1 ? "down" : "up";
                        return (
                          <button
                            key={direction}
                            type="button"
                            className="wl-arrow"
                            data-marker={"move-" + rule.id + "-" + direction}
                            aria-label={"Move " + rule.title + " " + direction}
                            disabled={disabled || !rule.editable || !groups[index + delta]?.editable}
                            onClick={(e) => {
                              focus.current = e.currentTarget;
                              move(index, index + delta);
                              setStatus(
                                rule.title +
                                  " moved to position " +
                                  (index + delta + 1) +
                                  " of " +
                                  groups.length +
                                  ".",
                              );
                            }}
                          >
                            {delta === 1 ? "↓" : "↑"}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <button
                    className="rule-row ui-disclosure"
                    type="button"
                    aria-expanded={selected}
                    aria-label={"Open " + rule.title}
                    data-marker={"rule-" + rule.id}
                    onClick={() => (selected ? close() : open(rule.id))}
                  >
                    {row}
                    <span className="rule-chevron ui-disclosure-chevron" aria-hidden="true">
                      ›
                    </span>
                  </button>
                )}
                {!matches && <p className="row-warning">Kept in view · no longer matches your search.</p>}
                {rule.editable && !rule.matchers.length && index < groups.length - 1 && (
                  <p className="row-warning">! Later rules cannot match this redirect/tproxy traffic.</p>
                )}
                {!!errors.length && (
                  <p className="row-warning field-error">{errors.map((v) => v.message).join(" · ")}</p>
                )}
                {selected && editor}
              </li>
            );
          })}
          {!visible.length && <li className="empty-list">No matching rules. Try a name, domain or IP.</li>}
        </ol>
        {ordering && (
          <>
            <span className="visually-hidden" role="status" data-marker="order-status">
              {status}
            </span>
            <div className="order-foot">
              <span className="muted">Order is saved to the draft.</span>
              <div className="inline-actions">
                <Action marker="order-cancel" onClick={cancel}>
                  cancel
                </Action>
                <Action marker="order-save" primary disabled={disabled || !dirty} onClick={save}>
                  save order
                </Action>
              </div>
            </div>
          </>
        )}
        {!groups.some((rule) => rule.id === editedId) && editor}
      </section>
    </div>
  );
}
