import { createLogger, format, transports } from 'winston';
import type { Format } from 'logform';
import DailyRotateFile from 'winston-daily-rotate-file';
import type * as Transport from 'winston-transport';
import type { TransformableInfo } from 'logform';
import type { Logger, LoggerFactory } from 'global-logger-factory';
import { WinstonLogger } from 'global-logger-factory';
import { logContext } from './LogContext';

// Custom metadata type to replace the old LogMetadata from CSS
interface LogMetadata {
  isPrimary?: boolean;
  pid?: number;
}


interface ConfigurableLoggerOptions {
  fileName?: string;
  maxSize?: string;
  maxFiles?: string;
  format?: string;
  showLocation?: boolean;
}

export class ConfigurableLoggerFactory implements LoggerFactory {
  private readonly level: string;
  private readonly fileName: string;
  private readonly maxSize: string;
  private readonly maxFiles: string;
  private readonly showLocation: boolean;
  private readonly fileTransport: DailyRotateFile;

  public constructor(level: string, options: ConfigurableLoggerOptions = {}) {
    this.level = level;
    this.fileName = options.fileName || './logs/application-%DATE%.log';
    this.maxSize = options.maxSize || '10m';
    this.maxFiles = options.maxFiles || '14d';
    this.showLocation = options.showLocation ?? false;
    this.fileTransport = new DailyRotateFile({
      filename: this.fileName,
      datePattern: 'YYYY-MM-DD',
      maxSize: this.maxSize,
      maxFiles: this.maxFiles,
    });
    // Prevent MaxListenersExceededWarning as this transport is shared across all loggers
    this.fileTransport.setMaxListeners(Infinity);
  }

  private readonly clusterInfo = (meta: LogMetadata): string => {
    if (meta.isPrimary) {
      return 'Primary';
    }
    // Use process.pid directly since CSS doesn't pass pid in metadata
    return `W-${process.pid}`;
  };

  public createLogger(label: string): Logger {
    return new WinstonLogger(createLogger({
      level: this.level,
      format: this.getFormat(label),
      transports: this.createTransports(label),
    }));
  }

  protected createTransports(label: string): Transport[] {
    return [
      new transports.Console({
        format: format.combine(
          format.colorize(),
          this.getFormat(label),
        ),
      }),
      this.fileTransport,
    ];
  }

  protected getFormat(label: string): Format {
    return format.combine(
      format.label({ label }),
      format.timestamp({
        format: () => {
          // 使用 sv-SE 区域设置获得类似 ISO 但为本地时间的格式: YYYY-MM-DD HH:mm:ss
          return new Date().toLocaleString('sv-SE', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        }
      }),
      format((info) => {
        const store = logContext.getStore();
        if (store?.requestId) {
          info.requestId = store.requestId;
        }
        return info;
      })(),
      format.metadata({ fillExcept: [ 'level', 'timestamp', 'label', 'message', 'requestId' ]}),
      format.printf(
        ({ level: levelInner, message, label: labelInner, timestamp, requestId, metadata: meta }: TransformableInfo): string => {
          const clusterInfo = this.clusterInfo(meta as LogMetadata);
          const requestInfo = requestId ? ` [Req:${requestId}]` : '';
          
          // 模块名后置于时间戳
          let displayLabel = labelInner;
          if (this.showLocation && labelInner) {
            const className = (labelInner as string).split('/').pop();
            if (className && className !== 'Object') {
              displayLabel = className;
            }
          }
          
          return `${timestamp}${requestInfo} [${displayLabel}] ${levelInner}: ${message}`;
        },
      ),
    );
  }
}
