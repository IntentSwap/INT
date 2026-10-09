// Written by scripts/make-brand.ts from the logo's source file. Do not edit by hand: run the script again.

/** The heights the logo is made for, in CSS pixels, each with the width that keeps its shape. */
export const LOGO_SIZES = {
  24: { width: 24, height: 24 },
  28: { width: 28, height: 28 },
  32: { width: 32, height: 32 },
} as const;

export type LogoHeight = keyof typeof LOGO_SIZES;

/** How many device pixels to a CSS pixel each height is made for. */
export const LOGO_DENSITIES = [1, 2, 3] as const;

/** The address of the logo at a height and a density: the file is as many pixels high as the two multiplied. */
export function logoSrc(height: LogoHeight, density: (typeof LOGO_DENSITIES)[number] = 1): string {
  return `/brand/logo-${height * density}.webp`;
}

/** The three files for one height, as a browser is told of them: it takes the one for its own screen. */
export function logoSrcSet(height: LogoHeight): string {
  return LOGO_DENSITIES.map((density) => `${logoSrc(height, density)} ${density}x`).join(", ");
}
