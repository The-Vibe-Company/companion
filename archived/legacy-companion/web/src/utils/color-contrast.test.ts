import { contrastRatio, parseColor, relativeLuminance } from "./color-contrast.js";

describe("color-contrast", () => {
  it("parses common color formats used by our UI styles", () => {
    expect(parseColor("#fef3c7")).toEqual({ r: 254, g: 243, b: 199, a: 1 });
    expect(parseColor("rgb(69, 26, 3)")).toEqual({ r: 69, g: 26, b: 3, a: 1 });
    expect(parseColor("rgba(255, 255, 255, 0.5)")).toEqual({ r: 255, g: 255, b: 255, a: 0.5 });
  });

  it("computes luminance for alpha colors when background is provided", () => {
    const luminance = relativeLuminance("rgba(255, 255, 255, 0.5)", "#000000");
    expect(luminance).toBeGreaterThan(0);
    expect(luminance).toBeLessThan(1);
  });

  it("validates the TopBar diff badge contrast in light and dark themes", () => {
    // This guards the badge pair used in TopBar against regressions on both themes.
    const lightRatio = contrastRatio("#92400e", "#fef3c7");
    const darkRatio = contrastRatio("#fde68a", "#451a03");
    expect(lightRatio).toBeGreaterThanOrEqual(4.5);
    expect(darkRatio).toBeGreaterThanOrEqual(4.5);
  });

  it("documents why the old dark warning badge failed contrast", () => {
    // Old style was warning yellow background + white text in dark mode.
    const oldDarkBadgeRatio = contrastRatio("#ffffff", "#f6e05e");
    expect(oldDarkBadgeRatio).toBeLessThan(4.5);
  });
});
