/**
 * Logs 页面 - 日志查看
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { Trash2, Download, Pause, Play } from 'lucide-react';
import { clsx } from 'clsx';
import { getLogs, subscribeLogs, type LogEntry } from '@/api/admin';
import AnsiToHtml from 'ansi-to-html';

const ansiConverter = new AnsiToHtml({
  fg: '#333',
  bg: '#fff',
  newline: true,
  escapeXML: true,
});

export function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [levelFilter, setLevelFilter] = useState<string>('all');
  const [paused, setPaused] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // 初始加载日志
  useEffect(() => {
    const loadInitialLogs = async () => {
      const initialLogs = await getLogs({ limit: 500 });
      setLogs(initialLogs);
    };
    loadInitialLogs();
  }, []);

  // 订阅实时日志 (SSE)
  useEffect(() => {
    if (paused) {
      // 暂停时关闭 SSE 连接
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      return;
    }

    // 开始订阅
    const unsubscribe = subscribeLogs(
      (newLogs) => {
        if (!paused) {
          setLogs((prev) => {
            const combined = [...prev, ...newLogs];
            // 保持最近500条日志
            return combined.slice(-500);
          });
        }
      },
      (error) => {
        console.error('Log stream error:', error);
      }
    );

    unsubscribeRef.current = unsubscribe;

    return () => {
      unsubscribe();
      unsubscribeRef.current = null;
    };
  }, [paused]);

  // 自动滚动到底部
  useEffect(() => {
    if (!paused) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, paused]);

  // 应用过滤器
  const filteredLogs = logs.filter(log => {
    const sourceMatch = sourceFilter === 'all' || log.source === sourceFilter;
    const levelMatch = levelFilter === 'all' || log.level === levelFilter;
    return sourceMatch && levelMatch;
  });

  // 清空日志
  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  // 导出日志
  const downloadLogs = useCallback(() => {
    const content = filteredLogs.map(log =>
      `[${log.timestamp}] [${log.level.toUpperCase()}] [${log.source}] ${log.message}`
    ).join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `xpod-logs-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredLogs]);

  // 格式化时间
  const formatTime = (timestamp: string) => {
    try {
      return new Date(timestamp).toLocaleTimeString();
    } catch {
      return timestamp;
    }
  };

  // 日志级别颜色
  const getLevelColor = (level: LogEntry['level']) => {
    switch (level) {
      case 'error': return 'text-red-500';
      case 'warn': return 'text-yellow-500';
      case 'debug': return 'text-gray-400';
      default: return 'text-gray-700';
    }
  };

  // 来源颜色
  const getSourceColor = (source: string) => {
    switch (source) {
      case 'xpod': return 'text-purple-600';
      case 'css': return 'text-green-600';
      case 'api': return 'text-blue-600';
      default: return 'text-gray-500';
    }
  };

  return (
    <div className="p-8 h-full flex flex-col">
      <div className="flex items-center justify-between mb-6 gap-4">
        <h1 className="type-h1 shrink-0">日志</h1>
        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          {/* 模块筛选 */}
          <Select value={sourceFilter} onValueChange={(value) => setSourceFilter(value)}>
            <SelectTrigger className="w-40 h-8 text-sm shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部模块</SelectItem>
              <SelectItem value="xpod">xpod</SelectItem>
              <SelectItem value="css">CSS</SelectItem>
              <SelectItem value="api">API</SelectItem>
            </SelectContent>
          </Select>

          {/* 日志等级筛选 */}
          <Select value={levelFilter} onValueChange={(value) => setLevelFilter(value)}>
            <SelectTrigger className="w-40 h-8 text-sm shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部等级</SelectItem>
              <SelectItem value="error">错误</SelectItem>
              <SelectItem value="warn">警告</SelectItem>
              <SelectItem value="info">信息</SelectItem>
              <SelectItem value="debug">调试</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPaused(!paused)}
            className="flex flex-row items-center gap-1.5 px-2 h-8 whitespace-nowrap"
          >
            {paused ? <Play className="w-4 h-4 shrink-0" /> : <Pause className="w-4 h-4 shrink-0" />}
            <span className="text-sm whitespace-nowrap">{paused ? '继续' : '暂停'}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={downloadLogs} className="flex flex-row items-center gap-1.5 px-2 h-8 whitespace-nowrap">
            <Download className="w-4 h-4 shrink-0" />
            <span className="text-sm whitespace-nowrap">导出</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={clearLogs} className="flex flex-row items-center gap-1.5 px-2 h-8 whitespace-nowrap">
            <Trash2 className="w-4 h-4 shrink-0" />
            <span className="text-sm whitespace-nowrap">清空</span>
          </Button>
        </div>
      </div>

      <Card variant="bordered" className="flex-1 overflow-hidden">
        <CardContent className="h-full p-0">
          <div className="h-full overflow-auto font-mono text-sm bg-background">
            {filteredLogs.length === 0 ? (
              <div className="p-4 text-gray-400 text-center">
                暂无日志
              </div>
            ) : (
              <div className="p-4 space-y-1 min-w-max">
                {filteredLogs.map((log, index) => (
                  <div key={index} className="flex gap-2 hover:bg-gray-100 px-2 py-0.5 rounded w-max min-w-full">
                    <span className="text-gray-400 shrink-0 w-20">
                      {formatTime(log.timestamp)}
                    </span>
                    <span className={clsx('shrink-0 w-14 font-semibold', getLevelColor(log.level))}>
                      [{log.level.toUpperCase()}]
                    </span>
                    <span className={clsx('shrink-0 w-12', getSourceColor(log.source))}>
                      [{log.source}]
                    </span>
                    <span 
                      className="text-gray-700 whitespace-pre" 
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
