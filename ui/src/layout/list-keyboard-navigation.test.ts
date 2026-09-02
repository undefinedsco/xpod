import { describe, expect, test } from 'vitest';
import { JSDOM } from 'jsdom';
import { handleListNavigationKeyDown } from './list-keyboard-navigation';

describe('list keyboard navigation', () => {
  test('moves focus with arrows and Home/End while leaving activation to Enter', () => {
    const dom = new JSDOM('<nav><a href="#a">A</a><a href="#b">B</a><a href="#c">C</a></nav>');
    const links = [...dom.window.document.querySelectorAll('a')] as HTMLAnchorElement[];
    links[1]!.focus();
    handleListNavigationKeyDown({ key: 'ArrowDown', currentTarget: links[1]!, preventDefault() {} });
    expect(dom.window.document.activeElement).toBe(links[2]);
    handleListNavigationKeyDown({ key: 'Home', currentTarget: links[2]!, preventDefault() {} });
    expect(dom.window.document.activeElement).toBe(links[0]);
    handleListNavigationKeyDown({ key: 'End', currentTarget: links[0]!, preventDefault() {} });
    expect(dom.window.document.activeElement).toBe(links[2]);
  });
});
