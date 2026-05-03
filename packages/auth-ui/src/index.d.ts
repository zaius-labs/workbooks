// @work.books/auth-ui — type declarations.

export const TOKENS_CSS_HREF: string;
export const LOGO_SVG_HREF: string;

export interface BrandTokens {
  readonly bg: string;
  readonly fg: string;
  readonly fgMute: string;
  readonly line: string;
  readonly codeBg: string;
  readonly ok?: string;
  readonly warn?: string;
  readonly err?: string;
  readonly fontSans?: string;
  readonly fontMono?: string;
}

export const TOKENS: BrandTokens;
export const TOKENS_DARK: BrandTokens;
