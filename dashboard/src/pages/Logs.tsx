// Logs - Real-time log viewer with filtering
import { useEffect, useRef, useState } from 'react';
import { getLogs, type LogEntry, type LogFilterOptions } from '../api';

export function Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filteredLogs, setFilteredLogs] = useState<LogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState<LogFilterOptions>({
    level: 'all',
    source: 'all',
    limit: 500,
  });
  const logEndRef = useRef<HTMLDivElement>(null);

  // Poll logs from API
  useEffect(() => {
    const pollLogs = async () => {
      try {
        const data = await getLogs(filters);
        if (data) {
          setLogs(data);
        }
      } catch (e) {
        console.error('Failed to fetch logs:', e);
      }
    };

    pollLogs();
    const interval = setInterval(pollLogs, 2000);
    return () => clearInterval(interval);
  }, [filters]);

  // Apply local search filter
  useEffect(() => {
    let result = logs;
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(log => 
        log.message.toLowerCase().includes(query) ||
        log.source.toLowerCase().includes(query)
      );
    }
    setFilteredLogs(result);
  }, [logs, searchQuery]);

  // Auto scroll to bottom
  useEffect(() => {
    if (autoScroll && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filteredLogs, autoScroll]);

  const getLevelColor = (level: LogEntry['level']) => {
    switch (level) {
      case 'info': return '#4ecdc4';
      case 'warn': return '#f38181';
      case 'error': return '#ff6b6b';
      default: return '#fff';
    }
  };

  const getSourceDisplay = (source: string) => {
    const map: Record<string, string> = {
      'xpod': 'System',
      'css': 'CSS',
      'api': 'API',
    };
    return map[source] || source;
  };

  const clearLogs = () => setLogs([]);

  const getLevelStats = () => {
    const stats = { info: 0, warn: 0, error: 0 };
    logs.forEach(log => {
      if (log.level in stats) {
        stats[log.level]++;
      }
    });
    return stats;
  };

  const stats = getLevelStats();

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <div style={{
        padding: '15px 20px',
        borderBottom: '1px solid #333',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}>
        {/* Top row: Title and stats */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ margin: 0, fontSize: '18px', color: '#fff' }}>服务日志</h1>
          <div style={{ display: 'flex', gap: '15px', fontSize: '12px' }}>
            <span style={{ color: '#4ecdc4' }}>INFO: {stats.info}</span>
            <span style={{ color: '#f38181' }}>WARN: {stats.warn}</span>
            <span style={{ color: '#ff6b6b' }}>ERROR: {stats.error}</span>
            <span style={{ color: '#888' }}>总计: {logs.length}</span>
          </div>
        </div>

        {/* Filter row */}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Search */}
          <input
            type="text"
            placeholder="搜索日志..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              padding: '6px 10px',
              background: '#2a2a3e',
              border: '1px solid #444',
              borderRadius: '4px',
              color: '#fff',
              fontSize: '13px',
              minWidth: '200px',
            }}
          />

          {/* Level filter */}
          <select
            value={filters.level}
            onChange={(e) => setFilters({ ...filters, level: e.target.value as LogFilterOptions['level'] })}
            style={{
              padding: '6px 10px',
              background: '#2a2a3e',
              border: '1px solid #444',
              borderRadius: '4px',
              color: '#fff',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            <option value="all">所有级别</option>
            <option value="info">INFO</option>
            <option value="warn">WARN</option>
            <option value="error">ERROR</option>
          </select>

          {/* Source filter */}
          <select
            value={filters.source}
            onChange={(e) => setFilters({ ...filters, source: e.target.value as LogFilterOptions['source'] })}
            style={{
              padding: '6px 10px',
              background: '#2a2a3e',
              border: '1px solid #444',
              borderRadius: '4px',
              color: '#fff',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            <option value="all">所有来源</option>
            <option value="xpod">System</option>
            <option value="css">CSS</option>
            <option value="api">API</option>
          </select>

          {/* Limit */}
          <select
            value={filters.limit}
            onChange={(e) => setFilters({ ...filters, limit: parseInt(e.target.value) })}
            style={{
              padding: '6px 10px',
              background: '#2a2a3e',
              border: '1px solid #444',
              borderRadius: '4px',
              color: '#fff',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            <option value={100}>最近 100 条</option>
            <option value={500}>最近 500 条</option>
            <option value={1000}>最近 1000 条</option>
          </select>

          {/* Auto scroll toggle */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '5px', color: '#888', cursor: 'pointer', fontSize: '13px' }}>
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            自动滚动
          </label>

          {/* Clear button */}
          <button
            onClick={clearLogs}
            style={{
              padding: '6px 12px',
              background: '#333',
              border: 'none',
              borderRadius: '4px',
              color: '#fff',
              cursor: 'pointer',
              fontSize: '13px',
              marginLeft: 'auto',
            }}
          >
            清空
          </button>
        </div>
      </div>

      {/* Log List */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '10px 20px',
        fontFamily: 'monospace',
        fontSize: '13px',
        lineHeight: '1.6',
      }}>
        {filteredLogs.length === 0 ? (
          <div style={{ color: '#666', textAlign: 'center', paddingTop: '50px' }}>
            暂无日志
          </div>
        ) : (
          filteredLogs.map((log, index) => (
            <div
              key={index}
              style={{
                padding: '4px 0',
                borderBottom: '1px solid #222',
                display: 'flex',
                gap: '15px',
              }}
            >
              <span style={{ color: '#666', minWidth: '140px' }}>{log.timestamp}</span>
              <span style={{ color: getLevelColor(log.level), minWidth: '50px', fontWeight: 'bold' }}>
                {log.level.toUpperCase()}
              </span>
              <span style={{ color: '#aa96da', minWidth: '80px' }}>[{getSourceDisplay(log.source)}]</span>
              <span style={{ color: '#fff', flex: 1, wordBreak: 'break-all' }}>{log.message}</span>
            </div>
          ))
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}
