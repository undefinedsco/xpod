export function shouldRedirectToConsent(
  isLoggedIn: boolean,
  hasOidcPending: boolean,
  allowOidcPending: boolean = false,
): boolean {
  return isLoggedIn && hasOidcPending && !allowOidcPending;
}
