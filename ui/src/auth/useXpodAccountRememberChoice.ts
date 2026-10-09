import { useState, type Dispatch, type SetStateAction } from 'react';
import { accountOverviewHref } from '../utils/account-overview-href';
import type { AccountCredentialsValues } from './XpodAccountViews';
import { readPendingXpodAccountEmail, readXpodAccountRememberChoice } from './xpod-remembered-login';

/** Keep the Account choice with its confirmed authority, including late bootstrap. */
export function useXpodAccountRememberChoice(idpIndex: string | undefined, isInitializing: boolean) {
  const issuer = confirmedAccountIssuer(idpIndex, isInitializing);
  const [selection, setSelection] = useState<{ issuer: string | undefined; value: boolean }>();
  // A bootstrap-era edit belongs to the first confirmed authority, never the next one.
  if (issuer && selection && selection.issuer === undefined) {
    setSelection({ issuer, value: selection.value });
  }
  const rememberedChoice = issuer ? readXpodAccountRememberChoice(issuer) : undefined;
  const rememberAccount = selection && (selection.issuer === issuer || selection.issuer === undefined) ? selection.value : rememberedChoice ?? false;
  const setRememberAccount = (value: boolean) => setSelection({ issuer, value });
  return [rememberAccount, setRememberAccount] as const;
}

function confirmedAccountIssuer(idpIndex: string | undefined, isInitializing: boolean): string | undefined {
  const accountHref = isInitializing ? undefined : accountOverviewHref(idpIndex);
  return accountHref ? new URL(accountHref).origin : undefined;
}

/** Transient credentials belong to one confirmed authority; passwords never enter storage. */
export function useXpodAccountCredentialValues(
  idpIndex: string | undefined,
  isInitializing: boolean,
  initialEmail?: string,
): readonly [AccountCredentialsValues, Dispatch<SetStateAction<AccountCredentialsValues>>, string | undefined] {
  const issuer = confirmedAccountIssuer(idpIndex, isInitializing);
  const hint = (scope: string): string => readPendingXpodAccountEmail(undefined, scope) ?? '';
  const [draft, setDraft] = useState(() => ({
    issuer,
    values: { email: initialEmail ?? (issuer ? hint(issuer) : ''), password: '', confirmation: '' } as AccountCredentialsValues,
    emailEdited: false,
  }));
  let current = draft;
  if (issuer && draft.issuer !== issuer) {
    const firstAuthority = draft.issuer === undefined;
    current = {
      issuer,
      values: firstAuthority
        ? { ...draft.values, email: draft.emailEdited ? draft.values.email : initialEmail ?? hint(issuer) }
        : { email: hint(issuer), password: '', confirmation: '' },
      emailEdited: firstAuthority && draft.emailEdited,
    };
    setDraft(current);
  }
  const setValues: Dispatch<SetStateAction<AccountCredentialsValues>> = (update) => {
    setDraft((previous) => {
      const values = typeof update === 'function' ? update(previous.values) : update;
      return { ...previous, values, emailEdited: previous.emailEdited || values.email !== previous.values.email };
    });
  };
  return [current.values, setValues, issuer] as const;
}
