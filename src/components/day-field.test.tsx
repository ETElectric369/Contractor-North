import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ChangeEvent, type ReactElement, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DayField, companyToday, type DayFieldProps } from "./day-field";

/**
 * THE ONE DAY FIELD (cn-v1153): a native `<input type="date">` in the house Input's clothes, 44px
 * tall, full width, no label and no words of its own. Controlled hands the iso string; uncontrolled
 * keeps name + defaultValue for a FormData form; `noPast` floors the box at the COMPANY's today in
 * its own zone (two companies at one instant get two different todays); a caller's `min` wins; the
 * ref reaches the input.
 */
const html = (props: DayFieldProps) => renderToStaticMarkup(createElement(DayField, props));

/** The element the forwardRef draws, without a DOM: its props are the inner input's. */
const inner = (props: DayFieldProps, ref: Ref<HTMLInputElement> | null = null) =>
  (DayField as unknown as { render: (p: DayFieldProps, r: Ref<HTMLInputElement> | null) => ReactElement<Record<string, unknown>> }).render(props, ref);

const localToday = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

afterEach(() => vi.useRealTimers());

describe("DayField", () => {
  it("renders a native date input in the house Input's clothes, 44px tall and full width, nothing else", () => {
    const out = html({});
    expect(out).toContain('type="date"');
    expect(out).toContain("h-11");
    expect(out).not.toContain("h-10"); // twMerge dropped Input's own height
    expect(out).toContain("w-full");
    expect(out).toContain("rounded-lg border border-slate-300");
    expect(out.startsWith("<input")).toBe(true);
    expect((out.match(/</g) ?? []).length).toBe(1); // no label, no wrapper, no words
    expect(html({ className: "max-w-xs" })).toContain("max-w-xs");
  });

  it("controlled: the value shows and onChange hands the iso string first, the event second", () => {
    expect(html({ value: "2026-11-08", onChange: () => {} })).toContain('value="2026-11-08"');
    const spy = vi.fn();
    const el = inner({ value: "2026-11-08", onChange: spy });
    const e = { target: { value: "2026-11-09" } } as unknown as ChangeEvent<HTMLInputElement>;
    (el.props.onChange as (e: ChangeEvent<HTMLInputElement>) => void)(e);
    expect(spy).toHaveBeenCalledWith("2026-11-09", e);
    const cleared = { target: { value: "" } } as unknown as ChangeEvent<HTMLInputElement>;
    (el.props.onChange as (e: ChangeEvent<HTMLInputElement>) => void)(cleared);
    expect(spy).toHaveBeenLastCalledWith("", cleared);
  });

  it("uncontrolled: name + defaultValue stay, so a form reading FormData by name keeps working", () => {
    const out = html({ name: "due_on", defaultValue: "2026-11-20" });
    expect(out).toContain('name="due_on"');
    expect(out).toContain('value="2026-11-20"');
    expect(html({ name: "due_on" })).not.toContain("value=");
  });

  it("noPast + tz floors the box at THAT company's today: one instant, two zones, two todays", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T05:30:00Z")); // 9:30 PM Nov 7 in Los Angeles, 6:30 PM Nov 8 in Auckland
    expect(companyToday("America/Los_Angeles")).toBe("2026-11-07");
    expect(companyToday("Pacific/Auckland")).toBe("2026-11-08");
    expect(html({ noPast: true, tz: "America/Los_Angeles" })).toContain('min="2026-11-07"');
    expect(html({ noPast: true, tz: "Pacific/Auckland" })).toContain('min="2026-11-08"');
    // No zone: the phone's own day.
    expect(companyToday(null)).toBe(localToday());
    expect(companyToday()).toBe(localToday());
    expect(html({ noPast: true, tz: null })).toContain(`min="${localToday()}"`);
    // Without noPast there is no floor at all.
    expect(html({ tz: "America/Los_Angeles" })).not.toContain("min=");
  });

  it("a caller's own min wins over noPast", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T05:30:00Z"));
    const out = html({ noPast: true, tz: "America/Los_Angeles", min: "2026-12-01" });
    expect(out).toContain('min="2026-12-01"');
    expect(out).not.toContain("2026-11-07");
  });

  it("every other prop passes through to the input", () => {
    const out = html({ id: "when", name: "when", required: true, disabled: true, autoFocus: true, max: "2027-01-01", "aria-label": "The day" });
    expect(out).toContain('id="when"');
    expect(out).toContain('name="when"');
    expect(out).toContain("required");
    expect(out).toContain("disabled");
    expect(out).toContain("autofocus");
    expect(out).toContain('max="2027-01-01"');
    expect(out).toContain('aria-label="The day"');
  });

  it("forwards its ref to the input", () => {
    expect((DayField as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.forward_ref"));
    const ref = { current: null as HTMLInputElement | null };
    const el = inner({}, ref);
    expect(el.props.ref).toBe(ref);
    expect(el.props.type).toBe("date");
  });
});
