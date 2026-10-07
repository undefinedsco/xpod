// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { Button } from './Button';
import { Input, Label } from './Input';
import { Card, CardContent, CardHeader, CardTitle } from './Card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './Select';

afterEach(cleanup);

test('labelled input preserves native form values, change events and disabled buttons', () => {
  const submit = vi.fn();
  function Form() {
    const [value, setValue] = useState('');
    return <form onSubmit={(event) => { event.preventDefault(); submit(new FormData(event.currentTarget).get('secret')); }}>
      <Label htmlFor="secret">密钥</Label>
      <Input id="secret" name="secret" value={value} onChange={(event) => setValue(event.target.value)} />
      <Button disabled={!value}>保存</Button>
      <Button type="button" onClick={() => setValue('')}>清空</Button>
    </form>;
  }
  render(<Form />);
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(submit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('密钥'), { target: { value: 'test-value' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(submit).toHaveBeenCalledWith('test-value');
  fireEvent.click(screen.getByRole('button', { name: '清空' }));
  expect((screen.getByLabelText('密钥') as HTMLInputElement).value).toBe('');
  expect(submit).toHaveBeenCalledTimes(1);
});

test('legacy bordered card composition keeps caller content and classes', () => {
  render(<Card variant="bordered" className="consumer-card"><CardHeader><CardTitle>状态</CardTitle></CardHeader><CardContent>已配置</CardContent></Card>);
  expect(screen.getByText('已配置').closest('.consumer-card')).not.toBeNull();
  expect(screen.getByText('状态')).toBeTruthy();
});

test('select keeps controlled value and disabled semantics', () => {
  render(<form aria-label="配置"><Select name="scope" value="private" disabled>
    <SelectTrigger aria-label="范围"><SelectValue /></SelectTrigger>
    <SelectContent><SelectItem value="private">私有</SelectItem><SelectItem value="public">公开</SelectItem></SelectContent>
  </Select></form>);
  expect((screen.getByRole('combobox', { name: '范围' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('combobox').textContent).toBe('私有');
});

test('shared primitives expose refs and compose a link without a nested button', async () => {
  const { createRef } = await import('react');
  const inputRef = createRef<HTMLInputElement>();
  const linkRef = createRef<HTMLButtonElement>();
  const click = vi.fn((event) => event.preventDefault());
  render(<><Input ref={inputRef} aria-label="目标" /><Button ref={linkRef} asChild onClick={click}><a href="/settings">设置</a></Button></>);
  expect(inputRef.current).toBe(screen.getByLabelText('目标'));
  expect(linkRef.current).toBe(screen.getByRole('link', { name: '设置' }));
  expect(screen.queryByRole('button')).toBeNull();
  fireEvent.click(screen.getByRole('link'));
  expect(click).toHaveBeenCalledTimes(1);
});


test('select keyboard opening and choice update the native form value', async () => {
  const originalScroll = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  try {
    function Form() {
      const [value, setValue] = useState('private');
      return <form aria-label="范围配置"><Select name="scope" value={value} onValueChange={setValue}>
        <SelectTrigger aria-label="范围"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="private">私有</SelectItem><SelectItem value="public">公开</SelectItem></SelectContent>
      </Select></form>;
    }
    render(<Form />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: '公开' }));
    await waitFor(() => expect(new FormData(screen.getByRole('form') as HTMLFormElement).get('scope')).toBe('public'));
    expect(screen.getByRole('combobox').textContent).toBe('公开');
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScroll;
  }
});
