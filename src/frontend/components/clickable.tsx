// A11y-correct stand-in for `<div onClick>`. Renders a div by default (so it
// inherits no UA button styling) but exposes role="button", tabIndex=0, and a
// keyboard handler so Enter/Space activate it. Use this anywhere a card, row,
// tile, or backdrop needs to be clickable without dragging in <button>'s
// default chrome.
import type { ComponentChildren, JSX } from "preact";

type Props = Omit<JSX.HTMLAttributes<HTMLDivElement>, "onClick"> & {
  onClick: (e: Event) => void;
  as?: keyof JSX.IntrinsicElements;
  children?: ComponentChildren;
  disabled?: boolean;
};

export function Clickable({
  onClick,
  onKeyDown,
  as: Tag = "div",
  disabled,
  children,
  ...rest
}: Props) {
  const handleKey = (e: KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick(e);
    }
    if (typeof onKeyDown === "function") onKeyDown(e as unknown as never);
  };
  return (
    // @ts-expect-error — dynamic tag name; preact's typing for createElement
    // with a string tag is correct at runtime, just not narrow enough here.
    <Tag
      {...rest}
      role="button"
      tabIndex={rest.tabIndex ?? (disabled ? -1 : 0)}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      onKeyDown={handleKey}
    >
      {children}
    </Tag>
  );
}
