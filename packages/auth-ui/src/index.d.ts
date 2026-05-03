// @work.books/auth-ui — type declarations.

import type { Component } from "svelte";

export const TOKENS_CSS_HREF: string;
export const LOGO_SVG_HREF: string;

export type SubmitResult =
  | { kind: "workos_redirect"; url: string }
  | { kind: "magic_link_request_id"; request_id: string }
  | {
      kind: "authenticated";
      bearer: string;
      sub: string;
      email: string;
      expires_at: number;
    }
  | { kind: "error"; message: string };

export interface SignInFormProps {
  onSubmit: (args: { email: string }) => Promise<SubmitResult> | SubmitResult;
  onVerify?: (args: {
    request_id: string;
    code: string;
  }) => Promise<SubmitResult> | SubmitResult;
  onAuthenticated?: (args: {
    bearer: string;
    sub: string;
    email: string;
    expires_at: number;
  }) => void;
  initialEmail?: string;
  title?: string;
  lede?: string;
}
export const SignInForm: Component<SignInFormProps>;

export interface MagicCodeInputProps {
  onComplete: (code: string) => void | Promise<void>;
  disabled?: boolean;
}
export const MagicCodeInput: Component<MagicCodeInputProps>;

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
