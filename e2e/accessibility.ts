import { expect, type Page } from "@playwright/test";

export async function expectScreenContrast(page: Page, screenName: string): Promise<void> {
  const audit = await page.evaluate(() => {
    type Color = { red: number; green: number; blue: number; alpha: number };
    const parseColor = (value: string): Color | null => {
      const match = /rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/.exec(value);
      return match
        ? {
            red: Number(match[1]) / 255,
            green: Number(match[2]) / 255,
            blue: Number(match[3]) / 255,
            alpha: match[4] === undefined ? 1 : Number(match[4])
          }
        : null;
    };
    const composite = (front: Color, back: Color): Color => {
      const alpha = front.alpha + back.alpha * (1 - front.alpha);
      if (alpha === 0) return { red: 1, green: 1, blue: 1, alpha: 1 };
      return {
        red: (front.red * front.alpha + back.red * back.alpha * (1 - front.alpha)) / alpha,
        green: (front.green * front.alpha + back.green * back.alpha * (1 - front.alpha)) / alpha,
        blue: (front.blue * front.alpha + back.blue * back.alpha * (1 - front.alpha)) / alpha,
        alpha
      };
    };
    const luminance = (color: Color): number => {
      const channel = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      return 0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue);
    };
    const ratio = (left: Color, right: Color): number => {
      const [lighter, darker] = [luminance(left), luminance(right)].sort((a, b) => b - a);
      return (lighter + 0.05) / (darker + 0.05);
    };
    const backgroundFor = (element: Element): Color => {
      const layers: Color[] = [];
      let current: Element | null = element;
      while (current) {
        const color = parseColor(getComputedStyle(current).backgroundColor);
        if (color && color.alpha > 0) layers.push(color);
        current = current.parentElement;
      }
      return layers.reverse().reduce(
        (background, layer) => composite(layer, background),
        { red: 1, green: 1, blue: 1, alpha: 1 }
      );
    };
    const failures: Array<{ selector: string; text: string; ratio: number; required: number }> = [];
    let checked = 0;
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const hasDirectText = Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
      );
      if (!hasDirectText || element.closest('[aria-hidden="true"]') || element.matches(":disabled")) continue;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) === 0 ||
        rect.width <= 1 ||
        rect.height <= 1 ||
        rect.bottom < 0 ||
        rect.top > window.innerHeight
      ) continue;
      const foreground = parseColor(style.color);
      if (!foreground) continue;
      const background = backgroundFor(element);
      const renderedForeground = composite(foreground, background);
      const fontSize = Number.parseFloat(style.fontSize);
      const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
      const required = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700) ? 3 : 4.5;
      const measured = ratio(renderedForeground, background);
      checked += 1;
      if (measured + 0.01 < required) {
        failures.push({
          selector: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${Array.from(element.classList).slice(0, 2).map((name) => `.${name}`).join("")}`,
          text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 100),
          ratio: Number(measured.toFixed(2)),
          required
        });
      }
    }
    return { checked, failures: failures.slice(0, 30) };
  });
  expect(audit.checked, `${screenName} should expose visible text for contrast auditing`).toBeGreaterThan(0);
  expect(audit.failures, `${screenName} has WCAG text contrast failures`).toEqual([]);
}
