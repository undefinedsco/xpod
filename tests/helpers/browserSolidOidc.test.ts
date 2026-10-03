import { errors, type Locator } from '@playwright/test';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
import { clickNonPasswordOidcAction } from './browserSolidOidc';

const CONTROL_SELECTOR = 'button, input[type=submit], a[href]';

it('returns to readiness detection when navigation removes a discovered control', async () => {
  const locator = { evaluate: vi.fn().mockRejectedValue(new errors.TimeoutError('Control disappeared')) } as unknown as Locator;
  expect(await clickNonPasswordOidcAction(locator)).toBe(false);
});

it('does not hide an unexpected action evaluation failure', async () => {
  const failure = new Error('Unexpected evaluation failure');
  const locator = { evaluate: vi.fn().mockRejectedValue(failure) } as unknown as Locator;
  await expect(clickNonPasswordOidcAction(locator)).rejects.toBe(failure);
});

/** JSDOM stub for `Locator.evaluate` that forwards the serialized argument. */
function stubLocator(element: Element) {
  const click = vi.spyOn(element as HTMLElement, 'click');
  const locator = {
    evaluate: async (fn: (element: Element, arg?: unknown) => unknown, arg?: unknown) => fn(element, arg),
    click,
  } as unknown as Locator;
  return { locator, click };
}

it.each(['<button>登录</button>', '<input type="submit" value="登录">'])('does not submit a password form mounted after the credential visibility check: %s', async (action) => {
  const dom = new JSDOM('<main></main>');
  try {
    // Reproduce the trace ordering: credentials were absent when probed, but
    // the login action exists by the time generic actions are discovered.
    expect(dom.window.document.querySelector('input[type=password]')).toBeNull();
    dom.window.document.querySelector('main')!.innerHTML = `<form><input type="email"><input type="password">${action}</form>`;
    const element = dom.window.document.querySelector<HTMLElement>(`${CONTROL_SELECTOR}`)!;
    const { locator, click } = stubLocator(element);
    expect(await clickNonPasswordOidcAction(locator)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});

it('also excludes submit controls linked to a password form by form ID', async () => {
  const dom = new JSDOM('<form id="credentials"><input name="password"></form><button form="credentials">登录</button>');
  try {
    const { locator, click } = stubLocator(dom.window.document.querySelector('button')!);
    expect(await clickNonPasswordOidcAction(locator)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});

it.each([
  '<form><button>批准</button></form>',
  '<button>使用 WebID 登录</button>',
  '<button>授权</button>',
  '<button>继续</button>',
  '<button>允许</button>',
  '<input type="submit" value="同意">',
  '<a href="#authorize">授权</a>',
  '<a href="#webid">使用 WebID 登录</a>',
])('continues non-password OIDC actions: %s', async (html) => {
  const dom = new JSDOM(html);
  try {
    const control = dom.window.document.querySelector<HTMLElement>(CONTROL_SELECTOR)!;
    const click = vi.fn((event: Event) => event.preventDefault());
    control.addEventListener('click', click);
    const { locator } = stubLocator(control);
    expect(await clickNonPasswordOidcAction(locator)).toBe(true);
    expect(click).toHaveBeenCalledOnce();
  } finally { dom.window.close(); }
});

// Safety: the broad primary discovery regex matches label fragments, so logout
// (退出登录 → 登录) and cancel-authorization (取消授权 → 授权) are discovered as
// candidates. Every control kind - button, submit input and anchor - must refuse
// them on the exact node that would be activated.
it.each([
  '<button>退出登录</button>',
  '<button>退出</button>',
  '<button>取消授权</button>',
  '<button>取消</button>',
  '<button>撤销访问</button>',
  '<button>切换账号</button>',
  '<button>Log out</button>',
  '<button>Revoke access</button>',
  '<button>Reject</button>',
  '<button>Deny</button>',
  '<input type="submit" value="取消授权">',
  '<a href="#logout">退出登录</a>',
  '<a href="#cancel">取消授权</a>',
  '<a href="#revoke">Revoke access</a>',
])('refuses to activate a disruptive OIDC action even when broad discovery matches it: %s', async (html) => {
  const dom = new JSDOM(html);
  try {
    const { locator, click } = stubLocator(dom.window.document.querySelector<HTMLElement>(CONTROL_SELECTOR)!);
    expect(await clickNonPasswordOidcAction(locator)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});

// The refusal rule is deliberately conservative: any of aria-label / text / value
// carrying a disruptive token refuses the control, whichever source disagrees.
it.each([
  '<button aria-label="退出登录">继续</button>',
  '<button aria-label="取消授权">授权</button>',
  '<a href="#x" aria-label="取消授权">继续授权</a>',
  '<button aria-label="授权">取消</button>',
])('refuses when aria-label conflicts with the visible label: %s', async (html) => {
  const dom = new JSDOM(html);
  try {
    const { locator, click } = stubLocator(dom.window.document.querySelector<HTMLElement>(CONTROL_SELECTOR)!);
    expect(await clickNonPasswordOidcAction(locator)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});

it('does not re-resolve an action replaced by a password submit after evaluation', async () => {
  const dom = new JSDOM('<main><button>继续</button></main>');
  try {
    const originalClick = vi.fn();
    const passwordSubmit = vi.fn((event: Event) => event.preventDefault());
    dom.window.document.querySelector('button')!.addEventListener('click', originalClick);
    const locator = {
      evaluate: async (fn: (element: Element, arg?: unknown) => unknown, arg?: unknown) => {
        const result = fn(dom.window.document.querySelector('button')!, arg);
        dom.window.document.querySelector('main')!.innerHTML = '<form><input type="password"><button>继续</button></form>';
        dom.window.document.querySelector('form')!.addEventListener('submit', passwordSubmit);
        return result;
      },
      click: async () => dom.window.document.querySelector('button')!.click(),
    } as unknown as Locator;
    expect(await clickNonPasswordOidcAction(locator)).toBe(true);
    expect(passwordSubmit).not.toHaveBeenCalled();
    expect(originalClick).toHaveBeenCalledOnce();
  } finally { dom.window.close(); }
});

it('activates the discovered anchor rather than a disruptive anchor that replaces it', async () => {
  const dom = new JSDOM('<main><a href="#authorize">继续</a></main>');
  try {
    const originalClick = vi.fn((event: Event) => event.preventDefault());
    const replacementClick = vi.fn((event: Event) => event.preventDefault());
    dom.window.document.querySelector('a')!.addEventListener('click', originalClick);
    const locator = {
      evaluate: async (fn: (element: Element, arg?: unknown) => unknown, arg?: unknown) => {
        const result = fn(dom.window.document.querySelector('a')!, arg);
        dom.window.document.querySelector('main')!.innerHTML = '<a href="#logout">退出登录</a>';
        dom.window.document.querySelector('a')!.addEventListener('click', replacementClick);
        return result;
      },
      click: async () => dom.window.document.querySelector('a')!.click(),
    } as unknown as Locator;
    expect(await clickNonPasswordOidcAction(locator)).toBe(true);
    expect(originalClick).toHaveBeenCalledOnce();
    expect(replacementClick).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});

it.each(['disabled', 'aria-disabled="true"'])('does not activate an action disabled after discovery: %s', async (attribute) => {
  const dom = new JSDOM(`<button ${attribute}>继续</button>`);
  try {
    const { locator, click } = stubLocator(dom.window.document.querySelector('button')!);
    expect(await clickNonPasswordOidcAction(locator)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});

it('does not activate a detached action', async () => {
  const dom = new JSDOM('<button>继续</button>');
  try {
    const element = dom.window.document.querySelector('button')!;
    element.remove();
    const { locator, click } = stubLocator(element);
    expect(await clickNonPasswordOidcAction(locator)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});
