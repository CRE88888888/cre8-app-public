import { useRef, type ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "../../components/ui/sheet";
export function ReferenceSheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  const previousFocus = useRef<HTMLElement | null>(null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        id="atp-reference-sheet"
        side="right"
        onOpenAutoFocus={() => {
          previousFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        }}
        onCloseAutoFocus={(event) => {
          const target = previousFocus.current;
          if (target && target !== document.body && target.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
        className="public-sheet w-full overflow-y-auto p-0 sm:max-w-2xl"
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription className="sr-only">
            {title} and source information.
          </SheetDescription>
        </SheetHeader>
        <div className="public-sheet-body">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
