import type { ComponentProps } from "react";
import { PopoverContent } from "@/components/ui/popover";

// Attach listeners only while Radix has mounted the popup. The visual viewport
// can shrink AND pan when a software keyboard opens; 100dvh alone misses both.
function trackVisualViewport(content: HTMLDivElement | null) {
  if (!content) return;
  const positioner = content.parentElement;
  if (!positioner) return;
  const viewport = window.visualViewport;
  const update = () => {
    positioner.style.setProperty("--entity-picker-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
    positioner.style.setProperty("--entity-picker-viewport-top", `${viewport?.offsetTop ?? 0}px`);
  };
  update();
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  return () => {
    viewport?.removeEventListener("resize", update);
    viewport?.removeEventListener("scroll", update);
    window.removeEventListener("resize", update);
  };
}

export function MobileEntityPickerContent(props: Omit<ComponentProps<typeof PopoverContent>, "ref">) {
  return <PopoverContent {...props} data-mobile-entity-picker="" ref={trackVisualViewport} />;
}
