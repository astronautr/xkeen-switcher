import { useRef, type ReactNode, type PointerEvent, type MouseEvent, type ComponentProps } from "react";
import { ActionButton, Button, type ButtonProps } from "../../ui/Button";
import { Dialog } from "../../ui/overlays";

function actionClass(primary: boolean) {
  return "t-btn" + (primary ? " primary ui-button-primary" : "");
}

export function PendingAction({ primary = false, ...props }: ComponentProps<typeof ActionButton> & { primary?: boolean }) {
  return <ActionButton {...props} className={"ui-button " + actionClass(primary)} />;
}

export function Action({ primary = false, ...props }: ButtonProps & { primary?: boolean }) {
  return (
    <Button
      {...props}
      variant="bracket"
      className={actionClass(primary)}
    />
  );
}
type Crumb = { label: string; marker: string; click: () => void };
export function Breadcrumbs({
  title,
  links,
  root = false,
}: {
  title: string;
  links: Crumb[];
  root?: boolean;
}) {
  return (
    <nav className="settings-breadcrumbs" aria-label="breadcrumb">
      <ol>
        {links.map(({ label, marker, click }, index) => (
          <li key={marker}>
            {index > 0 && (
              <span className="settings-slash" aria-hidden="true">
                /
              </span>
            )}
            <button
              type="button"
              className="settings-crumb"
              aria-label={label === "~" ? "home" : label}
              data-marker={marker}
              onClick={click}
            >
              {label}
            </button>
          </li>
        ))}
        <li>
          <span className="settings-slash" aria-hidden="true">
            /
          </span>
          {root ? (
            <h1 id="routing-title" aria-current="page">
              {title}
            </h1>
          ) : (
            <span id="routing-panel-title" tabIndex={-1} aria-current="page">
              {title}
            </span>
          )}
        </li>
      </ol>
    </nav>
  );
}
export function Panel({
  title,
  children,
  footer,
  embedded,
  go,
  close,
  feedback,
  confirm,
  links = [],
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  embedded?: boolean;
  go: (path: string) => void;
  close: () => void;
  feedback?: ReactNode;
  confirm?: ReactNode;
  links?: Crumb[];
}) {
  const outside = useRef(false);
  function onBackdrop(event: PointerEvent<HTMLDialogElement> | MouseEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return false;
    const box = event.currentTarget.getBoundingClientRect();
    return (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    );
  }
  const content = (
    <>
      <header className="panel-head">
        <Breadcrumbs
          title={title}
          links={[
            { label: "~", marker: "breadcrumb-home", click: () => go("") },
            { label: "routing", marker: "breadcrumb-routing", click: close },
            ...links,
          ]}
        />
        <Action marker="panel-close" onClick={close}>
          close
        </Action>
      </header>
      <div className="panel-body">
        {!embedded && <div data-marker="modal-operation-slot" />}
        <div data-marker="panel-feedback" role="status">
          {feedback}
        </div>
        {children}
      </div>
      <footer className={"panel-footer" + (embedded ? " editor-footer" : "")}>{footer}</footer>
      {confirm}
    </>
  );
  return embedded ? (
    <section
      className="routing-panel embedded-editor inline-editor"
      data-marker="routing-rule-editor"
      aria-labelledby="routing-panel-title"
    >
      {content}
    </section>
  ) : (
    <Dialog
      open
      marker="routing-panel"
      className="routing-panel"
      aria-labelledby="routing-panel-title"
      onClose={close}
      onPointerDown={(event) => {
        outside.current = onBackdrop(event);
      }}
      onClick={(event) => {
        if (outside.current && onBackdrop(event)) close();
        outside.current = false;
      }}
    >
      {content}
    </Dialog>
  );
}
