// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { MobileEntityPickerContent } from "./MobileEntityPickerContent";

const originalViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
afterEach(() => {
  if (originalViewport) Object.defineProperty(window, "visualViewport", originalViewport);
  else Reflect.deleteProperty(window, "visualViewport");
  document.body.innerHTML = "";
});

it("tracks keyboard resize and viewport pan only while the picker is mounted", async () => {
  const viewport = Object.assign(new EventTarget(), { height: 700, offsetTop: 0 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  const remove = vi.spyOn(viewport, "removeEventListener");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (open: boolean) => root.render(
    <Popover open={open}><PopoverTrigger>Choose</PopoverTrigger>
      <MobileEntityPickerContent><input aria-label="Search" /></MobileEntityPickerContent>
    </Popover>,
  );
  await act(() => render(true));
  const content = document.querySelector<HTMLElement>("[data-mobile-entity-picker]")!.parentElement!;
  expect(content.style.getPropertyValue("--entity-picker-viewport-height")).toBe("700px");
  viewport.height = 260;
  viewport.dispatchEvent(new Event("resize"));
  viewport.offsetTop = 110;
  viewport.dispatchEvent(new Event("scroll"));
  expect(content.style.getPropertyValue("--entity-picker-viewport-height")).toBe("260px");
  expect(content.style.getPropertyValue("--entity-picker-viewport-top")).toBe("110px");
  await act(() => render(false));
  expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
  expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
  viewport.height = 700;
  viewport.dispatchEvent(new Event("resize"));
  expect(content.style.getPropertyValue("--entity-picker-viewport-height")).toBe("260px");
  await act(() => root.unmount());
});

it("falls back to the window height without the Visual Viewport API", async () => {
  Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(() => root.render(
    <Popover open><PopoverTrigger>Choose</PopoverTrigger>
      <MobileEntityPickerContent>Options</MobileEntityPickerContent>
    </Popover>,
  ));
  const content = document.querySelector<HTMLElement>("[data-mobile-entity-picker]")!.parentElement!;
  expect(content.style.getPropertyValue("--entity-picker-viewport-height")).toBe(`${window.innerHeight}px`);
  expect(content.style.getPropertyValue("--entity-picker-viewport-top")).toBe("0px");
  await act(() => root.unmount());
});
