import type { Locator } from '@playwright/test';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
import { clickNonPasswordOidcAction } from './browserSolidOidc';

it.each(['<button>登录</button>', '<input type="submit" value="登录">'])('does not submit a password form mounted after the credential visibility check: %s', async (action) => {
  const dom = new JSDOM('<main></main>');
  try {
    // Reproduce the trace ordering: credentials were absent when probed, but
    // the login action exists by the time generic actions are discovered.
    expect(dom.window.document.querySelector('input[type=password]')).toBeNull();
    dom.window.document.querySelector('main')!.innerHTML = `<form><input type="email"><input type="password">${action}</form>`;
    const element = dom.window.document.querySelector<HTMLButtonElement | HTMLInputElement>('button, input[type=submit]')!;
    const click = vi.spyOn(element, 'click');
    const locator = { evaluate: async (fn: (element: Element) => boolean) => fn(element), click } as unknown as Locator;
    expect(await clickNonPasswordOidcAction(locator)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});

it('also excludes submit controls linked to a password form by form ID', async () => {
  const dom = new JSDOM('<form id="credentials"><input name="password"></form><button form="credentials">登录</button>');
  try {
    const element = dom.window.document.querySelector('button')!;
    const click = vi.spyOn(element, 'click');
    const locator = { evaluate: async (fn: (element: Element) => boolean) => fn(element) } as unknown as Locator;
    expect(await clickNonPasswordOidcAction(locator)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});

it.each(['<form><button>批准</button></form>', '<button>使用 WebID 登录</button>'])('continues non-password OIDC actions: %s', async (html) => {
  const dom = new JSDOM(html);
  try {
    const click = vi.fn((event: Event) => event.preventDefault());
    dom.window.document.querySelector('button')!.addEventListener('click', click);
    const locator = { evaluate: async (fn: (element: Element) => boolean) => fn(dom.window.document.querySelector('button')!) } as unknown as Locator;
    expect(await clickNonPasswordOidcAction(locator)).toBe(true);
    expect(click).toHaveBeenCalledOnce();
  } finally { dom.window.close(); }
});


it('does not re-resolve an action replaced by a password submit after evaluation', async () => {
  const dom = new JSDOM('<main><button>继续</button></main>');
  try {
    const originalClick = vi.fn();
    const passwordSubmit = vi.fn((event: Event) => event.preventDefault());
    dom.window.document.querySelector('button')!.addEventListener('click', originalClick);
    const locator = {
      evaluate: async (fn: (element: Element) => boolean) => {
        const result = fn(dom.window.document.querySelector('button')!);
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


it.each(['disabled', 'aria-disabled="true"'])('does not activate an action disabled after discovery: %s', async (attribute) => {
  const dom = new JSDOM(`<button ${attribute}>继续</button>`);
  try {
    const element = dom.window.document.querySelector('button')!;
    const click = vi.spyOn(element, 'click');
    const locator = { evaluate: async (fn: (element: Element) => boolean) => fn(element) } as unknown as Locator;
    expect(await clickNonPasswordOidcAction(locator)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});

it('does not activate a detached action', async () => {
  const dom = new JSDOM('<button>继续</button>');
  try {
    const element = dom.window.document.querySelector('button')!;
    element.remove();
    const click = vi.spyOn(element, 'click');
    const locator = { evaluate: async (fn: (element: Element) => boolean) => fn(element) } as unknown as Locator;
    expect(await clickNonPasswordOidcAction(locator)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  } finally { dom.window.close(); }
});
