import {
  memo,
  useLayoutEffect,
  useReducer,
  useRef,
  type ComponentPropsWithRef,
  type DOMAttributes,
  type InputHTMLAttributes,
  type RefObject,
  type TextareaHTMLAttributes,
} from "react";
type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
export function clearValidity(event: { currentTarget: Control }) {
  event.currentTarget.setCustomValidity("");
}
export function englishValidity(event: { currentTarget: Control }) {
  const field = event.currentTarget;
  field.setCustomValidity("");
  const input = field as HTMLInputElement;
  field.setCustomValidity(
    field.validity.valueMissing
      ? "Enter a value."
      : field.validity.tooShort
        ? `Use at least ${input.minLength} characters.`
        : field.validity.rangeUnderflow || field.validity.rangeOverflow
          ? `Enter a value from ${input.min} to ${input.max}.`
          : input.type === "url" || field.id === "subscription-home-url"
            ? "Enter a valid http:// or https:// URL."
            : "Check this value and try again.",
  );
}

type Input = HTMLInputElement | HTMLTextAreaElement;

// Browsers can have marked text and a selection before they publish the next input event.
// Give the browser ownership of the live value until the composition finishes, even after blur.
function useTextValue<T extends Input>(
  value: string | undefined,
  props: DOMAttributes<T>,
  externalRef?: RefObject<T | null>,
) {
  const localRef = useRef<T>(null);
  const ref = externalRef ?? localRef;
  const composing = useRef(false);
  const [, finishComposition] = useReducer((generation: number) => generation + 1, 0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (value !== undefined && node && !composing.current && node.value !== value) node.value = value;
  });
  const events: DOMAttributes<T> = {
    onCompositionStart(event) {
      composing.current = true;
      props.onCompositionStart?.(event);
    },
    onCompositionEnd(event) {
      composing.current = false;
      props.onCompositionEnd?.(event);
      // Some engines publish the final input after compositionend.
      requestAnimationFrame(finishComposition);
    },
    onInput(event) {
      clearValidity(event);
      props.onInput?.(event);
    },
    onInvalid(event) {
      englishValidity(event);
      props.onInvalid?.(event);
    },
  };
  const text = value === undefined ? {} : { value: undefined, defaultValue: value };
  return { composing, bind: { ref, ...text, ...events } };
}

export function Field({ marker, ref, ...props }: InputHTMLAttributes<HTMLInputElement> & {
  marker: string;
  ref?: RefObject<HTMLInputElement | null>;
}) {
  const textual = ["text", "search", "url", "password"].includes(props.type ?? "text");
  const value = textual && typeof props.value === "string" ? props.value : undefined;
  const { bind } = useTextValue<HTMLInputElement>(value, props, ref);
  return <input {...props} {...bind} data-marker={marker} />;
}

// Updating even an unchanged native textarea.defaultValue replaces its text node.
// Let React skip that host update while the browser is composing.
const NativeTextarea = memo(
  function NativeTextarea({
    composing, ...props
  }: ComponentPropsWithRef<"textarea"> & { composing: RefObject<boolean> }) {
    return <textarea {...props} />;
  },
  (previous, next) => next.composing.current && previous.disabled === next.disabled,
);

export function Textarea({ marker, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { marker: string }) {
  const value = typeof props.value === "string" ? props.value : undefined;
  const { composing, bind } = useTextValue<HTMLTextAreaElement>(value, props);
  const change = useRef(props.onChange);
  useLayoutEffect(() => { change.current = props.onChange; });
  return (
    <NativeTextarea
      {...props}
      {...bind}
      composing={composing}
      data-marker={marker}
      onChange={(event) => change.current?.(event)}
    />
  );
}
