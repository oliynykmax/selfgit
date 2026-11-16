import { Toast, ToastClose, ToastDescription, ToastRegion, ToastTitle } from "@ui-sdk/react/toast";
import { X } from "lucide-react";

export function Toaster() {
  return (
    <ToastRegion data-agent-hidden className="fixed right-4 bottom-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
      {() => (
        <Toast className="relative rounded-lg border bg-popover p-3 pr-9 text-sm shadow-md data-[type=error]:border-destructive/40">
          <ToastTitle className="font-medium" />
          <ToastDescription className="mt-0.5 text-muted-foreground" />
          <ToastClose aria-label="Dismiss" className="absolute top-2 right-2 grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted">
            <X className="size-3.5" />
          </ToastClose>
        </Toast>
      )}
    </ToastRegion>
  );
}
