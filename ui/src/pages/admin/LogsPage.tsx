/**
 * Logs page - runtime log inspection and sanitized diagnostics
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Input';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { Download, FileDown, Pause, Play, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { buildDiagnosticsSnapshot, getLogFileTail, getLogs, subscribeLogs, type LogEntry } from '@/api/admin';
import AnsiToHtml from 'ansi-to-html';

const ansiConverter = new AnsiToHtml({
  fg: 'hsl(var(--foreground))',
  bg: 'hsl(var(--background))',
  newline: true,
  escapeXML: true,
});

function knownErrorHint(message: string): string | null {
  if (message.includes('ERR_NGROK_8001')) {
    return 'ERR_NGROK_8001: ngrok agent 无法连到 ngrok edge，通常是本机网络或代理限制。';
  }
  if (message.includes('ERR_NGROK_9009')) {
    return 'ERR_NGROK_9009: 当前 ngrok 计划或代理路径不允许该用法。';
  }
  if (message.includes('DNS') || message.includes('DDNS')) {
    return 'DNS/DDNS 相关错误：检查 Cloud 协调状态和当前公网地址。';
  }
  return null;
}

function DiagnosticsPanel(props: { onExport: () => void; exporting: boolean; logFileInfo: string }) {
  return (
    <Card variant="bordered" className="mb-4">
      <CardHeader className="pb-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>诊断导出</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">导出可交给开发者的脱敏运行时证据，默认不包含用户 Pod 内容。</p>
          </div>
          <Button onClick={props.onExport} disabled={props.exporting} className="gap-2">
            <FileDown className="h-4 w-4" />
            导出诊断
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm lg:grid-cols-[1fr_auto] lg:items-end">
        <div className="space-y-2">
          <div>
            <span className="font-medium">包含：</span>
            <span className="text-muted-foreground">/service/status、隧道、DDNS、运行时配置摘要、最近错误和日志尾部。</span>
          </div>
          <div>
            <span className="font-medium">排除：</span>
            <span className="text-muted-foreground">Token、API key、数据库密码、认证 cookie、client secret、用户 Pod 内容。</span>
          </div>
        </div>
        <div className="text-xs text-muted-foreground lg:text-right">
          日志文件: {props.logFileInfo}
        </div>
      </CardContent>
    </Card>
  );
}

export function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [levelFilter, setLevelFilter] = useState<string>('all');
  const [keywordFilter, setKeywordFilter] = useState('');
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [streamError, setStreamError] = useState('');
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const [logFileInfo, setLogFileInfo] = useState('未读取');
  const logsEndRef = useRef<HTMLDivElement>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const loadInitialLogs = async () => {
      const initialLogs = await getLogs({ limit: 500 });
      setLogs(initialLogs);
      const fileTail = await getLogFileTail({ lines: 20 });
      setLogFileInfo(fileTail?.file ?? '未找到日志文件');
    };
    void loadInitialLogs();
  }, []);

  useEffect(() => {
    if (paused) {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      return;
    }

    const unsubscribe = subscribeLogs(
      (newLogs) => {
        setStreamError('');
        setLogs((prev) => [...prev, ...newLogs].slice(-500));
      },
      () => {
        setStreamError('日志流连接异常，已保留当前视图。');
      },
    );

    unsubscribeRef.current = unsubscribe;

    return () => {
      unsubscribe();
      unsubscribeRef.current = null;
    };
  }, [paused]);

  useEffect(() => {
    if (autoScroll && !paused) {
      logsEndRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [logs, paused, autoScroll]);

  const filteredLogs = useMemo(() => {
    const keyword = keywordFilter.trim().toLowerCase();
    return logs.filter((log) => {
      const sourceMatch = sourceFilter === 'all' || log.source === sourceFilter;
      const levelMatch = levelFilter === 'all' || log.level === levelFilter;
      const keywordMatch = !keyword || `${log.timestamp} ${log.level} ${log.source} ${log.message}`.toLowerCase().includes(keyword);
      return sourceMatch && levelMatch && keywordMatch;
    });
  }, [logs, sourceFilter, levelFilter, keywordFilter]);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  const downloadLogs = useCallback(() => {
    const content = filteredLogs.map(log =>
      `[${log.timestamp}] [${log.level.toUpperCase()}] [${log.source}] ${log.message}`,
    ).join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `xpod-logs-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredLogs]);

  const exportDiagnostics = useCallback(async () => {
    setExportingDiagnostics(true);
    try {
      const snapshot = await buildDiagnosticsSnapshot();
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `xpod-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExportingDiagnostics(false);
    }
  }, []);

  const formatTime = (timestamp: string) => {
    try {
      return new Date(timestamp).toLocaleTimeString();
    } catch {
      return timestamp;
    }
  };

  const getLevelColor = (level: LogEntry['level']) => {
    switch (level) {
      case 'error': return 'text-destructive';
      case 'warn': return 'text-amber-600 dark:text-amber-300';
      case 'debug': return 'text-muted-foreground';
      default: return 'text-foreground';
    }
  };

  const getSourceColor = (source: string) => {
    switch (source) {
      case 'xpod': return 'text-primary';
      case 'css': return 'text-green-700 dark:text-green-300';
      case 'api': return 'text-blue-700 dark:text-blue-300';
      case 'gateway': return 'text-amber-700 dark:text-amber-300';
      default: return 'text-muted-foreground';
    }
  };

  const firstHint = filteredLogs.map((log) => knownErrorHint(log.message)).find(Boolean);

  return (
    <div className="p-4 sm:p-8 h-full flex flex-col max-w-6xl">
      <div className="flex flex-col gap-4 mb-6 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="type-h1">日志</h1>
          <p className="mt-2 max-w-[65ch] text-sm text-muted-foreground">实时检查运行时输出，并导出不包含 secret 的诊断证据。</p>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <Button variant="ghost" size="sm" onClick={() => setPaused(!paused)} className="gap-1.5 whitespace-nowrap">
            {paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            {paused ? '继续' : '暂停'}
          </Button>
          <Button variant="ghost" size="sm" onClick={downloadLogs} className="gap-1.5 whitespace-nowrap">
            <Download className="w-4 h-4" />
            导出日志
          </Button>
          <Button variant="ghost" size="sm" onClick={clearLogs} className="gap-1.5 whitespace-nowrap">
            <Trash2 className="w-4 h-4" />
            清空视图
          </Button>
        </div>
      </div>

      <DiagnosticsPanel onExport={exportDiagnostics} exporting={exportingDiagnostics} logFileInfo={logFileInfo} />

      <div className="mb-4 grid gap-3 lg:grid-cols-[160px_160px_1fr_auto]">
        <Select value={sourceFilter} onValueChange={(value) => setSourceFilter(value)}>
          <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部模块</SelectItem>
            <SelectItem value="xpod">xpod</SelectItem>
            <SelectItem value="gateway">Gateway</SelectItem>
            <SelectItem value="css">CSS</SelectItem>
            <SelectItem value="api">API</SelectItem>
            <SelectItem value="tunnel">Tunnel</SelectItem>
          </SelectContent>
        </Select>
        <Select value={levelFilter} onValueChange={(value) => setLevelFilter(value)}>
          <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部等级</SelectItem>
            <SelectItem value="error">错误</SelectItem>
            <SelectItem value="warn">警告</SelectItem>
            <SelectItem value="info">信息</SelectItem>
            <SelectItem value="debug">调试</SelectItem>
          </SelectContent>
        </Select>
        <div>
          <Label htmlFor="keywordFilter" className="sr-only">关键词</Label>
          <Input id="keywordFilter" value={keywordFilter} onChange={(event) => setKeywordFilter(event.target.value)} placeholder="按关键词过滤" className="h-9" />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />
          自动滚动
        </label>
      </div>

      {streamError ? <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{streamError}</div> : null}
      {firstHint ? <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200">{firstHint}</div> : null}

      <Card variant="bordered" className="flex-1 min-h-[420px] overflow-hidden">
        <CardContent className="h-full p-0">
          <div className="h-full overflow-auto font-mono text-sm bg-background">
            {filteredLogs.length === 0 ? (
              <div className="p-6 text-muted-foreground text-center">
                暂无日志
              </div>
            ) : (
              <div className="p-4 space-y-1 min-w-max">
                {filteredLogs.map((log, index) => (
                  <div key={`${log.timestamp}-${index}`} className="flex gap-2 hover:bg-muted px-2 py-0.5 rounded w-max min-w-full">
                    <span className="text-muted-foreground shrink-0 w-20">
                      {formatTime(log.timestamp)}
                    </span>
                    <span className={clsx('shrink-0 w-14 font-semibold', getLevelColor(log.level))}>
                      [{log.level.toUpperCase()}]
                    </span>
                    <span className={clsx('shrink-0 w-20', getSourceColor(log.source))}>
                      [{log.source}]
                    </span>
                    <span
                      className="text-foreground whitespace-pre"
                      dangerouslySetInnerHTML={{ __html: ansiConverter.toHtml(log.message) }}
                    />
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
