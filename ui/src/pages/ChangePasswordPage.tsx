import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { storedAccountTokenHeaders } from '../utils/account-session';

export function ChangePasswordPage() {
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (next !== confirm) { setMessage('两次输入的新密码不一致'); return; }
    const response = await fetch('/idp/credentials/password/', {
      method: 'POST',
      headers: storedAccountTokenHeaders({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }),
      credentials: 'include',
      body: new URLSearchParams({ oldPassword: current, newPassword: next, confirmPassword: confirm }),
    });
    setMessage(response.ok ? '密码已更新' : `修改失败（${response.status}）`);
  };
  return <main style={{ maxWidth: 520, margin: '48px auto', padding: 24 }}><h1>修改密码</h1><form onSubmit={submit}>
    <input aria-label="当前密码" type="password" value={current} onChange={e => setCurrent(e.target.value)} placeholder="当前密码" required />
    <input aria-label="新密码" type="password" value={next} onChange={e => setNext(e.target.value)} placeholder="新密码" required />
    <input aria-label="确认新密码" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="确认新密码" required />
    <button type="submit">保存密码</button><button type="button" onClick={() => navigate('/.account/account/')}>返回</button>
  </form>{message && <p role="status">{message}</p>}</main>;
}
