/** A geometric chevron that sits on the text's optical centre, unlike ^ ⌄ ▸ ▾ glyphs. */
export function Chevron({ direction = "down", className }: {
  direction?: "up" | "down" | "left" | "right";
  className?: string;
}) {
  return (
    <span className={"ui-chevron" + (className ? " " + className : "")} data-direction={direction} aria-hidden="true">
      <svg viewBox="0 0 10 10" focusable="false">
        <polyline points="2,3.5 5,6.5 8,3.5" />
      </svg>
    </span>
  );
}
