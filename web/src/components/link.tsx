import type * as React from "react";
import { navigate } from "@/lib/navigation";

type LinkProps = React.ComponentProps<"a"> & { href: string };

export function Link({ href, onClick, ...props }: LinkProps) {
  return (
    <a
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        navigate(href);
      }}
      {...props}
    />
  );
}
