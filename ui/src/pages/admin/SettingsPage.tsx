/**
 * Settings 页面 - 配置管理
 */

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Label, Select } from '@/components/ui/Input';
import { getAdminConfig, updateAdminConfig, triggerRestart } from '@/api/admin';
import { clsx } from 'clsx';

export function SettingsPage() {
  const [env, setEnv] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const config = await getAdminConfig();
      if (config) {
        setEnv(config.env);
      }
    } catch (e) {
      console.error('Failed to load config:', e);
    } finally {
      setLoading(false);
    }
  };

  const saveConfig = async () => {
    setSaving(true);
    setMessage('');
    try {
      const success = await updateAdminConfig(env);
      if (success) {
        setMessage('配置已保存，需要重启服务生效');
      } else {
        setMessage('保存失败');
      }
    } catch (e) {
      setMessage(`保存失败: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const handleRestart = async () => {
    setMessage('正在重启服务...');
    const success = await triggerRestart();
    if (success) {
      setMessage('重启信号已发送，请稍候...');
      // 等待服务重启后刷新页面
      setTimeout(() => {
        window.location.reload();
      }, 3000);
    } else {
      setMessage('重启失败');
    }
  };

  const updateEnv = (key: string, value: string) => {
    setEnv(prev => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return <div className="p-8 text-foreground">加载中...</div>;
  }

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="type-h1 mb-8">设置</h1>

      {/* Basic Settings */}
      <Card variant="bordered" className="mb-6">
        <CardHeader>
          <CardTitle>基本设置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>数据目录</Label>
            <Input
              value={env.CSS_ROOT_FILE_PATH || './data'}
              onChange={(e) => updateEnv('CSS_ROOT_FILE_PATH', e.target.value)}
            />
          </div>

          <div>
            <Label>端口</Label>
            <Input
              type="number"
              value={env.CSS_PORT || '3000'}
              onChange={(e) => updateEnv('CSS_PORT', e.target.value)}
              className="w-32"
            />
          </div>

          <div>
            <Label>Base URL</Label>
            <Input
              value={env.CSS_BASE_URL || 'http://localhost:3000'}
              onChange={(e) => updateEnv('CSS_BASE_URL', e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Database Settings */}
      <Card variant="bordered" className="mb-6">
        <CardHeader>
          <CardTitle>数据库配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>SPARQL 存储</Label>
            <Input
              value={env.CSS_SPARQL_ENDPOINT || 'sqlite:./data/quadstore.sqlite'}
              onChange={(e) => updateEnv('CSS_SPARQL_ENDPOINT', e.target.value)}
            />
          </div>

          <div>
            <Label>身份数据库</Label>
            <Input
              value={env.CSS_IDENTITY_DB_URL || 'sqlite:./data/identity.sqlite'}
              onChange={(e) => updateEnv('CSS_IDENTITY_DB_URL', e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Logging Settings */}
      <Card variant="bordered" className="mb-6">
        <CardHeader>
          <CardTitle>日志配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>日志级别</Label>
            <Select
              value={env.CSS_LOGGING_LEVEL || 'info'}
              onChange={(e) => updateEnv('CSS_LOGGING_LEVEL', e.target.value)}
              className="w-40"
            >
              <option value="error">Error</option>
              <option value="warn">Warn</option>
              <option value="info">Info</option>
              <option value="debug">Debug</option>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="showStackTrace"
              checked={env.CSS_SHOW_STACK_TRACE === 'true'}
              onChange={(e) => updateEnv('CSS_SHOW_STACK_TRACE', e.target.checked ? 'true' : 'false')}
              className="rounded border-input"
            />
            <label htmlFor="showStackTrace" className="text-sm text-foreground">
              显示错误堆栈
            </label>
          </div>
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex items-center gap-4">
        <Button onClick={saveConfig} disabled={saving}>
          {saving ? '保存中...' : '保存配置'}
        </Button>
        <Button variant="secondary" onClick={handleRestart}>
          保存并重启
        </Button>
      </div>

      {message && (
        <div className={clsx(
          'mt-4 text-sm',
          message.includes('失败') ? 'text-destructive' : 'text-green-500'
        )}>
          {message}
        </div>
      )}
    </div>
  );
}
