import { forwardRef, useEffect, useRef, useState, type InputHTMLAttributes } from "react";

type NumberInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "type" | "value"> & {
  value: number;
  onValueChange: (value: number) => void;
};

/**
 * A controlled numeric field with a local editing buffer.
 *
 * Financial state stays numeric, but an in-progress field may be empty. Keeping
 * those two concerns separate prevents React from immediately putting `0` back
 * after the user deletes it.
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { value, onValueChange, min = 0, max, onBlur, onFocus, ...props },
  forwardedRef,
) {
  const [text, setText] = useState(() => format(value));
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setText(format(value));
  }, [value]);

  const lower = finiteBound(min);
  const upper = finiteBound(max);
  const normalize = (raw: string) => {
    const parsed = raw === "" ? (lower ?? 0) : Number(raw);
    if (!Number.isFinite(parsed)) return lower ?? 0;
    return Math.min(upper ?? Number.POSITIVE_INFINITY, Math.max(lower ?? Number.NEGATIVE_INFINITY, parsed));
  };

  return (
    <input
      {...props}
      ref={forwardedRef}
      type="number"
      min={min}
      max={max}
      value={text}
      onFocus={(event) => {
        editing.current = true;
        onFocus?.(event);
      }}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        onValueChange(normalize(next));
      }}
      onBlur={(event) => {
        editing.current = false;
        const next = normalize(event.target.value);
        setText(format(next));
        onValueChange(next);
        onBlur?.(event);
      }}
    />
  );
});

function finiteBound(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function format(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}
